"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = require("path");
const util_1 = require("util");
const fs_1 = require("fs");
const os_1 = require("os");
const inquirer_1 = require("inquirer");
const forge = require("node-forge");
const randomstring = require("randomstring");
const mkdirp = require("mkdirp");
const cronParser = require("cron-parser");
const lodash_1 = require("lodash");
const dbackedApi_1 = require("./dbackedApi");
const log_1 = require("./log");
const dbStats_1 = require("./dbStats");
const s3_1 = require("./s3");
const helpers_1 = require("./helpers");
const writeFileAsync = util_1.promisify(fs_1.writeFile);
var DB_TYPE;
(function (DB_TYPE) {
    DB_TYPE["pg"] = "pg";
    DB_TYPE["mysql"] = "mysql";
    DB_TYPE["mongodb"] = "mongodb";
})(DB_TYPE = exports.DB_TYPE || (exports.DB_TYPE = {}));
var SUBSCRIPTION_TYPE;
(function (SUBSCRIPTION_TYPE) {
    SUBSCRIPTION_TYPE["free"] = "free";
    SUBSCRIPTION_TYPE["premium"] = "premium";
})(SUBSCRIPTION_TYPE = exports.SUBSCRIPTION_TYPE || (exports.SUBSCRIPTION_TYPE = {}));
const configFields = [
    {
        name: 'subscriptionType',
        desc: 'What version of DBacked do you want to use?',
        options: [{ name: 'DBacked Free', value: 'free' }, { name: 'DBacked Pro', value: 'premium' }],
        required: true,
    },
    { name: 'agentId', desc: 'Server name', default: `${os_1.hostname()}-${randomstring.generate(4)}` },
    {
        name: 'configDirectory',
        doNotAsk: true,
        desc: 'Configuration directory',
        default: '/etc/dbacked',
    }, {
        name: 'dumpProgramsDirectory',
        doNotAsk: true,
        desc: 'Database dumper and restorer download location',
        default: '/tmp/dbacked_dumpers',
    }, {
        name: 'apikey',
        desc: 'DBacked API key',
        if: ({ subscriptionType }) => subscriptionType === 'premium',
        validate: async ({ apikey }) => {
            dbackedApi_1.registerApiKey(apikey);
            await dbackedApi_1.getProject();
            return true;
        },
    }, {
        name: 's3accessKeyId',
        desc: 'S3 Access Key ID',
        if: ({ subscriptionType }) => subscriptionType === 'free',
        required: true,
    }, {
        name: 's3secretAccessKey',
        desc: 'S3 Secret Access Key',
        type: 'password',
        if: ({ subscriptionType }) => subscriptionType === 'free',
        required: true,
    }, {
        name: 's3region',
        desc: 'S3 Region',
        if: ({ subscriptionType }) => subscriptionType === 'free',
        // TODO: validate region
        required: true,
    }, {
        name: 's3bucket',
        desc: 'S3 Bucket',
        if: ({ subscriptionType }) => subscriptionType === 'free',
        required: true,
        validate: async ({ s3accessKeyId, s3secretAccessKey, s3bucket, s3region, }) => {
            try {
                await s3_1.getBucketInfo({
                    s3accessKeyId, s3secretAccessKey, s3bucket, s3region,
                });
                return true;
            }
            catch (e) {
                return `Error from S3: ${e.toString()}`;
            }
        },
    }, {
        name: 'generateKeyPair',
        desc: 'Backup encryption key',
        options: [{
                value: true, name: 'Generate a new key pair',
            }, {
                value: false, name: 'Use an existing public key',
            }],
        virtual: true,
        if: ({ subscriptionType, publicKey }) => !publicKey && subscriptionType === SUBSCRIPTION_TYPE.free,
    }, {
        name: 'newKeyPairPassword',
        desc: 'Private key password',
        type: 'password',
        virtual: true,
        if: (config) => config.generateKeyPair,
        required: true,
    }, {
        name: 'newKeyPairPasswordConfirm',
        desc: 'Private key password confirm',
        type: 'password',
        virtual: true,
        if: (config) => config.generateKeyPair,
        required: true,
        validate: (config) => {
            if (config.newKeyPairPassword !== config.newKeyPairPasswordConfirm) {
                return 'Password and confirm do not match';
            }
            return true;
        },
        transform: async ({ newKeyPairPassword }) => {
            console.log('Generating key pair, this can take some time...');
            const keypair = await util_1.promisify(forge.pki.rsa.generateKeyPair)({ bits: 4096, workers: -1 });
            const publicKeyPem = forge.pki.publicKeyToPem(keypair.publicKey);
            const privateKeyPem = forge.pki
                .encryptRsaPrivateKey(keypair.privateKey, newKeyPairPassword);
            const privateKeyPath = path_1.resolve(process.cwd(), 'dbacked_private_key.pem');
            await writeFileAsync(privateKeyPath, privateKeyPem);
            console.log(`Saved private key to: ${privateKeyPath}`);
            return {
                publicKey: publicKeyPem,
            };
        },
    }, {
        name: 'publicKey',
        type: 'editor',
        required: true,
        desc: 'RSA Public Key to encrypt the backups',
        if: (config) => !config.generateKeyPair,
        validate: ({ publicKey }) => {
            try {
                forge.pki.publicKeyFromPem(publicKey);
                return true;
            }
            catch (e) {
                return `Error while testing public key: ${e.toString()}`;
            }
        },
    },
    {
        name: 'dbType',
        desc: 'Database type',
        options: [
            { name: 'PostgreSQL', value: 'pg' },
            { name: 'MySQL', value: 'mysql' },
            { name: 'MongoDB', value: 'mongodb' },
        ],
        required: true,
    },
    {
        name: 'dbConnectionString',
        desc: 'Database connection string (starts with mongodb://)',
        if: ({ dbType }) => dbType === 'mongodb',
    },
    { name: 'dbHost', desc: 'Database Host', if: ({ dbType }) => dbType !== 'mongodb' },
    { name: 'dbPort', desc: 'Database Port', if: ({ dbType }) => dbType !== 'mongodb' },
    {
        name: 'dbUsername',
        desc: 'Database username',
        required: true,
        if: ({ dbType }) => dbType !== 'mongodb',
    }, {
        name: 'dbPassword',
        desc: 'Database password',
        type: 'password',
        if: ({ dbType }) => dbType !== 'mongodb',
    }, {
        name: 'dbName',
        desc: 'Database name',
        required: true,
        validate: async (config, interactive = false) => {
            try {
                const databaseBackupableInfo = await dbStats_1.getDatabaseBackupableInfo(config.dbType, config);
                if (interactive) {
                    console.log('\nDBacked will backup these tables: (lines counts are an estimate)');
                    console.log(helpers_1.formatDatabaseBackupableInfo(databaseBackupableInfo));
                }
                return true;
            }
            catch (e) {
                return `Error while connecting to database: ${e.toString()}`;
            }
        },
    },
    { name: 'dumperOptions', desc: 'Command line option to set on pg_dump, mongodump or mysqldump' },
    {
        name: 'cron',
        desc: 'When do you want to start the backups? (UTC Cron Expression)',
        if: ({ subscriptionType }) => subscriptionType === 'free',
        validate: ({ cron }) => {
            try {
                cronParser.parseExpression(cron);
                return true;
            }
            catch (e) {
                return `Error while parsing cron expression: ${e.toString()}`;
            }
        },
    }, {
        name: 'daemon',
        desc: 'Daemonize / Run backup process in background',
        doNotAsk: true,
    }, {
        name: 'daemonName',
        desc: 'Daemon name, used to run multiple daemon of DBacked at the same time',
        doNotAsk: true,
    },
];
const readFilePromisified = util_1.promisify(fs_1.readFile);
exports.getConfigFileContent = async (configDirectory) => {
    const filePath = path_1.resolve(configDirectory, 'config.json');
    const fileContent = await readFilePromisified(filePath, { encoding: 'utf-8' });
    return JSON.parse(fileContent);
};
// Create a new object from merge of both config object
const mergeConfigs = (...configs) => {
    // Merge without undefined values
    const res = {};
    configs.forEach((config) => {
        configFields.forEach((field) => {
            if (field.virtual) {
                return;
            }
            if (config[field.name]) {
                res[field.name] = config[field.name];
            }
        });
    });
    return res;
};
// Create a new object from merge of both config object
const mergeConfigsWithVirtuals = (...configs) => {
    // Merge without undefined values
    const res = {};
    configs.forEach((config) => {
        configFields.forEach((field) => {
            if (config[field.name]) {
                res[field.name] = config[field.name];
            }
        });
    });
    return res;
};
const mkdirpPromisified = util_1.promisify(mkdirp);
const writeFilePromisified = util_1.promisify(fs_1.writeFile);
const saveConfig = async (config) => {
    try {
        await mkdirpPromisified(config.configDirectory);
    }
    catch (e) { }
    const filePath = path_1.resolve(config.configDirectory, 'config.json');
    try {
        await writeFilePromisified(filePath, JSON.stringify(config, null, 4));
    }
    catch (e) {
        log_1.default.error('Couldn\'t save JSON config file', { filePath, error: e.message });
    }
};
const askForConfig = async (inferredConfig) => {
    let answers = {};
    for (const configField of configFields) {
        if (configField.doNotAsk) {
            continue;
        }
        if (configField.if && !configField.if(mergeConfigsWithVirtuals(inferredConfig, answers))) {
            continue;
        }
        const answer = await inquirer_1.prompt({
            type: configField.type || (configField.options ? 'list' : 'input'),
            name: 'res',
            default: inferredConfig[configField.name] || configField.default,
            message: configField.desc,
            choices: configField.options,
            validate: async (res) => {
                if (configField.required && !res) {
                    return 'Required';
                }
                if (configField.validate) {
                    return configField.validate(mergeConfigsWithVirtuals(inferredConfig, answers, { [configField.name]: res }), true);
                }
                return true;
            },
        });
        answers[configField.name] = answer.res;
        if (configField.transform) {
            answers = mergeConfigsWithVirtuals(answers, await configField.transform(mergeConfigsWithVirtuals(inferredConfig, answers)));
        }
    }
    return mergeConfigs(inferredConfig, answers);
};
const checkConfig = async (config) => {
    const errors = [];
    for (const configField of configFields) {
        let error;
        if (configField.if && !configField.if(config)) {
            continue;
        }
        if (configField.required && !config[configField.name]) {
            error = 'Required';
        }
        else if (configField.validate) {
            const validateResult = await configField.validate(config);
            if (validateResult !== true) {
                error = validateResult || 'Parsing error';
            }
        }
        if (error) {
            errors.push(`Error with '${configField.name}': ${error} (configurable with DBACKED_${lodash_1.snakeCase(configField.name).toUpperCase()} env variable, --${lodash_1.kebabCase(configField.name)} command line arg of ${configField.name} config variable)`);
        }
    }
    if (errors.length) {
        throw new Error(errors.join('\n'));
    }
};
exports.getConfig = async (commandLine, { interactive = false, saveOnDisk = false } = {}) => {
    let config = {
        configDirectory: commandLine.configDirectory || '/etc/dbacked',
    };
    try {
        const configFileContent = await exports.getConfigFileContent(config.configDirectory);
        config = mergeConfigs(config, configFileContent);
    }
    catch (e) { }
    // Get config from env variables
    config = mergeConfigs(config, lodash_1.fromPairs(configFields.map(({ name }) => [
        name,
        process.env[`DBACKED_${lodash_1.snakeCase(name).toUpperCase()}`],
    ])));
    // Get config from commandLine
    config = mergeConfigs(config, lodash_1.fromPairs(configFields.map(({ name }) => [
        name,
        commandLine[lodash_1.kebabCase(name)],
    ])));
    if (interactive) {
        config = await askForConfig(config);
    }
    await checkConfig(config);
    if (saveOnDisk) {
        await saveConfig(config);
    }
    return config;
};
//# sourceMappingURL=config.js.map