## backup-folder
Backup a big folder to google cloud storage.

This script will backup your local folder to google cloud storage, it will only upload files that have changed between successive runs and will never delete any files (even if they are deleted from local folder).

GCS credentials are required for `backup-folder` to run, see [Authentication](#authentication) for details.

## Install
```sh
npm install -g backup-folder
# OR
yarn global add backup-folder
```

## How To Use

#### Options
```
backup-folder -h

Usage: index [options] <source> <destination>

Backup a local folder to google cloud storage

Arguments:
  source         local folder to backup
  destination    gcs address where backup should be uploaded (must start with
                 gs://) (eg. gs://my-bucket/my-folder/)

Options:
  -V, --version  output the version number
  -p, --print    only print files to be uploaded, do not actually upload
                 (default: false)
  -h, --help     display help for command
```

#### Example
```sh
# Backup ./src/images to inside images folder of google cloud storage bucket my-bucket
backup-folder ./src/images/ gs://my-bucket/images/
```

## Authentication
You can authenticate to google cloud storage either via `gcloud` command or using a service account.

#### Via gcloud
```sh
gcloud auth application-default login
```

#### Via service account
```sh
GOOGLE_APPLICATION_CREDENTIALS=<service account key.json> backup-folder <source> <destination>
# OR
export GOOGLE_APPLICATION_CREDENTIALS=<service account key.json>
backup-folder <source> <destination>
```

## How it works?
`backup-folder` will create a file named `.backup-folder.json` inside the local folder. This metadata file contains the timestamp when the folder was backed up. Running `backup-folder` again will read the last timestamp from this file and will only upload files which were modified after the last timestamp.

## Why not use gsutil rsync or cp?
* `rsync` command queries all the files in the destination bucket, which will create a lot of class A api requests (not free) and will cost you a lot if only small number of files are changing.
* `cp` will copy the whole folder which will again use a lot of bandwidth and going to cost a lot more.

Use `backup-folder` when you want to backup a folder which a large number of files, but only small number of files are added / changed per day.