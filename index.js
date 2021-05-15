#! /usr/bin/env node
const fs = require("fs").promises;
const path = require("path");
const {Storage} = require('@google-cloud/storage');
const {program} = require('commander');
const chalk = require('chalk');
const package = require('./package.json');
const ParallelQueue = require('async-parallel-queue');

const isWinows = process.platform === 'win32';

const storage = new Storage();
const queue = new ParallelQueue({concurrency: 100});

function logError(e) {
	if (e instanceof Error) {
		console.error(chalk.red.bold(e.stack || e.message));
	}
	else {
		console.error(chalk.red.bold(e));
	}
}

/**
 * Format bytes as human-readable text.
 * 
 * @param {number} bytes Number of bytes.
 * @param {number} dp Number of decimal places to display.
 * 
 * @returns {string} Formatted string.
 */
 function humanFileSize(bytes, dp = 1) {  
	if (Math.abs(bytes) < 1024) {
		return bytes + ' B';
	}
  
	const units = ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
	let u = -1;
	const r = 10**dp;
  
	do {
		bytes /= 1024;
		++u;
	} while (Math.round(Math.abs(bytes) * r) / r >= 1024 && u < units.length - 1);

	return bytes.toFixed(dp) + ' ' + units[u];
}

/**
 * Format milliseconds as human-readable duration.
 * 
 * @param {number} milliseconds 
 * @returns {string} Formatted string
 */
function millisecondsToStr(milliseconds) {
	let temp = milliseconds / 1000;
	const 
		years = Math.floor(temp / 31536000),
		days = Math.floor((temp %= 31536000) / 86400),
		hours = Math.floor((temp %= 86400) / 3600),
		minutes = Math.floor((temp %= 3600) / 60),
		seconds = temp % 60;

	return (
		(years ? years + "y " : "") +
		(days ? days + "d " : "") +
		(hours ? hours + "h " : "" ) +
		(minutes ? minutes + "m " : "") +
		Number.parseFloat(seconds).toFixed(2) + "s"
	);
}

/**
 * Retry a function a number of times
 */
async function withRetries(fn, {retries = 3} = {}) {
	let actualRetries = 0;
	let lastError = null;
	while (actualRetries < retries) {
		try {
			return (await fn());
		}
		catch (e) {
			logError(e.message);
			lastError = e;
			actualRetries++;
		}
	}
	throw lastError;
}

async function* walk(dir) {
    for await (const d of await fs.opendir(dir)) {
        const entry = path.join(dir, d.name);
        if (d.isDirectory()) {
			yield* walk(entry);
		}
        else if (d.isFile()) {
			const stats = await fs.lstat(entry);
			stats.path = entry;
			yield stats;
		}
    }
}

program.version(package.version)
	.arguments('<source> <destination>')
	.description('Backup a local folder to google cloud storage', {
		source: 'local folder to backup',
		destination: 'gcs address where backup should be uploaded (must start with gs://) (eg. gs://my-bucket/my-folder/)',
	})
	.allowExcessArguments(false)
	.option('-p, --print', 'only print files to be uploaded, do not actually upload', false)
	.option('-q, --quiet', "quiet mode, don't print the files to be uploaded to stdout", false)
	.action(() => {});

const cmd = program.parse(process.argv);
let [source, destination] = cmd.args;
const opts = program.opts();
const onlyPrint = opts.print;
const quiet = opts.quiet;

if (source.startsWith('gs://')) {
	logError("source can't be a google cloud bucket");
	process.exit(1);
}
if (!destination.startsWith('gs://')) {
	logError("destination must be a google cloud folder");
	process.exit(1);
}

if (!path.isAbsolute(source)) {
	source = path.join(process.cwd(), source);
}

const bucketMatches = destination.match(/^gs:\/\/([a-zA-Z0-9_-]+)(?:\/|$)/);
const bucket = bucketMatches?.[1];
if (!bucket) {
	logError("invalid destination");
	process.exit(1);
}

const destinationDir = destination.substring(bucket.length + 5) || '/';
if (!destinationDir.startsWith('/')) {
	destinationDir = `/${destinationDir}`;
}

async function main() {
	let totalFiles = 0;
	let totalSize = 0;
	let totalUploadedFiles = 0;
	let totalUploadedSize = 0;
	let metadataFilePath = path.join(source, '.backup-folder.json');
	let metadata = {};
	try {
		metadata = await fs.readFile(metadataFilePath);
		metadata = JSON.parse(metadata.toString().trim());
		if (!metadata.uploadStartTime) {
			logError(`invalid metadata file (${metadataFilePath})`);
			process.exit(1);
		}
	}
	catch (e) {
		if (e.code === 'ENOENT') {
			// metadata file does not exist, ignore
			// TODO: read metadata file from google cloud
		}
		else {
			logError(`Can't read metadata file (${metadataFilePath})`);
			logError(e.message);
			process.exit(1);
		}
	}
	let lastUploadTimeMs = new Date(metadata.uploadStartTime || 0).getTime();
	let uploadStartTime = new Date();
	const storageBucket = storage.bucket(bucket);
	const uploadedLabel = onlyPrint ? 'will upload' : 'uploaded';

	let fileNum = 0;
	const upload = queue.fn(async (file) => {
		const destination = path.relative(source, file.path);
		if (isWinows) {
			destination = destination.replace(/\\/g, '/');
		}
		if (!onlyPrint) {
			await withRetries(() => storageBucket.upload(file.path, {
				destination: path.join(destinationDir, destination).substring(1),
			}));
		}
		if (!quiet) {
			console.log(`${chalk.dim(++fileNum)} ${uploadedLabel} ${chalk.dim(destination)} (${chalk.bold(humanFileSize(file.size))})`);
		}
		totalUploadedFiles++;
		totalUploadedSize += file.size;
	}, {ignoreResult: true});

	let i = 0;
	for await (const file of walk(source)) {
		if (file.path === metadataFilePath) {
			// ignore metadata file
			continue;
		}

		totalFiles++;
		totalSize += file.size;

		if (file.mtimeMs >= lastUploadTimeMs) {
			upload(file);
		}

		if (++i % 10000 === 0) {
			console.log(chalk.blueBright(`Done ${i} files`));
		}
	}

	let filesUploaded = false;
	if (queue.size >= 1) {
		filesUploaded = true;
		console.log('waiting to all files to be uploaded');
	}
	await queue.waitIdle();
	if (filesUploaded) {
		console.log('all files uploaded');
	}

	let uploadEndTime = new Date();
	delete metadata.lastMetaData;
	metadata = {
		uploadStartTime,
		uploadEndTime,
		lastMetaData: metadata,
	};
 
	// write metadata file
	const metadataFileContents = JSON.stringify(metadata, null, '\t');
	if (!onlyPrint) {
		await fs.writeFile(metadataFilePath, metadataFileContents);
	}
	totalFiles++;
	totalSize += metadataFileContents.length;
	// upload metadata file
	upload({
		path: metadataFilePath,
		size: metadataFileContents.length,
	});

	await queue.waitIdle();
	const timeTaken = uploadEndTime.getTime() - uploadStartTime.getTime();

	console.log(chalk.green([
		`${uploadedLabel} ${chalk.bold(`${totalUploadedFiles} / ${totalFiles}`)} files` ,
		`(${chalk.bold(`${humanFileSize(totalUploadedSize)} / ${humanFileSize(totalSize)}`)})`,
	].join(' ')));
	console.log(chalk.green(`Done in ${chalk.bold(millisecondsToStr(timeTaken))}!`));
}

main().then(() => {
	process.exit();
}).catch((e) => {
	logError(e);
	process.exit(1);
});
