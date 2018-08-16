import { createHash } from 'crypto';
import { PassThrough } from 'stream';

import { getUploadPartUrl, finishUpload } from './dbackedApi';
import logger from './log';
import { checkDbDumpProgram } from './dbDumpProgram';
import { startDumper, createBackupKey } from './dbDumper';
import { uploadToS3, initMultipartUpload, getUploadPartUrlFromLocalCredentials, completeMultipartUpload } from './s3';
import { VERSION } from './constants';
import { Config, SUBSCRIPTION_TYPE } from './config';
import { DateTime } from 'luxon';

let backup;

logger.debug('Backup worker starting');
export const backupDatabase = async (config: Config, backupInfo) => {
  try {
    backup = backupInfo.backup || {};
    await checkDbDumpProgram(config.dbType, config.dumpProgramsDirectory);
    const hash = createHash('md5');

    // key is the unique AES key, encrypted key is this AES key encrypted with the RSA public key
    const { key: backupKey, encryptedKey } = await createBackupKey(config.publicKey);
    // IV is the initiation vector of the AES algorithm
    const { backupStream, iv } = await startDumper(backupKey, config);

    logger.debug('Creating backup file stream PassThrough');
    const backupFileStream = new PassThrough({
      highWaterMark: 201 * 1024 * 1024, // this is the max chunk size + 1MB
    });
    // Magic bytes used to verify Backup file
    backupFileStream.write(Buffer.from('DBACKED'));
    backupFileStream.write(Buffer.from([...VERSION]));
    backupFileStream.write(Buffer.from(<ArrayBuffer>(
      new Uint32Array([encryptedKey.length])).buffer));
    backupFileStream.write(encryptedKey);
    backupFileStream.write(iv);
    backupStream.pipe(backupFileStream);
    // Need a passthrough because else the stream is just consumed by the hash
    const uploadingStream = new PassThrough({
      highWaterMark: 201 * 1024 * 1024, // this is the max chunk size + 1MB
    });
    backupFileStream.pipe(uploadingStream);
    backupFileStream.pipe(hash);


    if (config.subscriptionType === SUBSCRIPTION_TYPE.free) {
      backup.filename = `backup_${config.dbName}_${DateTime.utc().toFormat('ddLLyyyyHHmm')}`;
      backup.s3uploadId = await initMultipartUpload(backup.filename, config);
    }

    const partsEtag = await uploadToS3({
      fileStream: uploadingStream,
      generateBackupUrl: async ({ partNumber, partHash }) => {
        logger.debug('Getting multipart upload URL for part number', { partNumber });
        if (config.subscriptionType === SUBSCRIPTION_TYPE.premium) {
          const { partUploadUrl } = await getUploadPartUrl({
            backup, partNumber, agentId: config.agentId, hash: partHash,
          });
          return partUploadUrl;
        }
        return getUploadPartUrlFromLocalCredentials({
          filename: backup.filename,
          uploadId: backup.s3uploadId,
          partNumber,
          partHash,
        }, config);
      },
    });
    logger.info('Informing server the upload is finished');
    hash.end();
    if (config.subscriptionType === SUBSCRIPTION_TYPE.premium) {
      await finishUpload({
        backup,
        partsEtag,
        hash: (<any>hash.read()).toString('hex'),
        agentId: config.agentId,
        publicKey: config.publicKey,
      });
    } else if (config.subscriptionType === SUBSCRIPTION_TYPE.free) {
      await completeMultipartUpload({
        filename: backup.filename,
        uploadId: backup.s3uploadId,
        partsEtag,
      }, config);
      // TODO: save last backup date in db
      // TODO: save a JSON file in s3 containing: dbType, hash, size, publicKey
      // TODO: send beacon to DBacked API
    }
    logger.info('backup finished !');
    process.exit(0);
  } catch (e) {
    logger.error('Unknown error while creating backup', { error: e.code || (e.response && e.response.data) || e.message });
    process.send(JSON.stringify({
      type: 'error',
      payload: `${JSON.stringify(e.code || (e.response && e.response.data) || e.message)}\n${e.stack}`,
    }));
  }
};

process.on('message', (message) => {
  try {
    const { type, payload } = JSON.parse(message);
    if (type === 'startBackup') {
      backupDatabase(payload.config, payload.backupInfo);
    }
  } catch (e) {}
});

process.on('uncaughtException', (e) => {
  console.error(e);
  const error = <any>e;
  process.send(JSON.stringify({
    type: 'error',
    payload: `${error.code || (error.response && error.responserror.data) || error.message}\n${error.stack}`,
  }));
  process.exit(1);
});
