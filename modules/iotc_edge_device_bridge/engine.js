const crypto = require('crypto');
const request = require('request-promise-native');
const Device = require('azure-iot-device');
const DeviceTransport = require('azure-iot-device-http');
var ProtocolMQTT = require('azure-iot-device-mqtt').Mqtt;
var ModuleClient = require('azure-iot-device').ModuleClient;

const util = require('util');
const StatusError = require('./error').StatusError;
const registrationHost = 'global.azure-devices-provisioning.net';
const registrationSasTtl = 3600; // 1 hour
const registrationApiVersion = `2019-01-15`;
const registrationRetryTimeouts = [500, 1000, 2000, 4000];
const minDeviceRegistrationTimeout = 60 * 1000; // 1 minute

const deviceCache = {};
let gatewayClient = null;
let connectionStringTokens = null;

/**
 * Forwards external telemetry messages for IoT Central devices.
 * @param {{ idScope: string, log: Function, getSecret: (context: Object, secretUrl: string) => string }} context 
 * @param {{ deviceId: string }} device 
 * @param {{ [field: string]: number }} measurements 
 */
module.exports = async function (context, device, measurements) {

    if (!connectionStringTokens) {
        parseConnectionString();
    }
    console.log(`Gateway DeviceId ${connectionStringTokens.DeviceId}`);
    device.gatewayId = connectionStringTokens.DeviceId;

    const hrstart = process.hrtime();

    if (device) {
        if (!device.deviceId || !/^[a-z0-9\-]+$/.test(device.deviceId)) {
            throw new StatusError('Invalid format: deviceId must be alphanumeric, lowercase, and may contain hyphens.', 400);
        }
    } else {
        throw new StatusError('Invalid format: a device specification must be provided.', 400);
    }

    if (!validateMeasurements(measurements)) {
        throw new StatusError('Invalid format: invalid measurement list.', 400);
    }

    if (!gatewayClient) {
        gatewayClient = await ModuleClient.fromEnvironment(ProtocolMQTT);
        try {
            await util.promisify(gatewayClient.open.bind(gatewayClient))();

        } catch (e) {
            throw new Error(`Unable to send telemetry for gateway device ${device.gatewayDeviceId}: ${e.message}`);
        }
    }

    const client = Device.Client.fromConnectionString(await getDeviceConnectionString(context, device), DeviceTransport.Http);

    try {
        await util.promisify(client.open.bind(client))();
        context.log('[HTTP] Sending telemetry for device', device.deviceId);
        await util.promisify(client.sendEvent.bind(client))(new Device.Message(JSON.stringify(measurements)));
        await util.promisify(client.close.bind(client))();
        const diff = process.hrtime(hrstart);
        console.info('Execution time: %d %d', diff[0], diff[1] / 10000);
        context.log('[MQTT] Sending telemetry for gateway device');
        util.promisify(gatewayClient.sendEvent.bind(gatewayClient))(new Device.Message(JSON.stringify({ ["leafDeviceExecutionTimeSec"]: diff[0] })));

    } catch (e) {
        // If the device was deleted, we remove its cached connection string
        if (e.name === 'DeviceNotFoundError' && deviceCache[device.deviceId]) {
            delete deviceCache[device.deviceId].connectionString;
        }

        throw new Error(`Unable to send telemetry for device ${device.deviceId}: ${e.message}`);
    }
};

function parseConnectionString() {
    connectionStringTokens = {};
    const conString = process.env.EdgeHubConnectionString;
    console.log(`Edge Module connection string ${conString}`);
    conString.split(';').forEach((conToken) => {
        var parts = conToken.split('=');
        if (parts.length === 2) {
            connectionStringTokens[parts[0]] = parts[1];
            console.log(parts[0], parts[1]);
        }
    });
}

/**
 * @returns true if measurements object is valid, i.e., a map of field names to numbers or strings.
 */
function validateMeasurements(measurements) {
    if (!measurements || typeof measurements !== 'object') {
        return false;
    }

    for (const field in measurements) {
        if (typeof measurements[field] !== 'number' && typeof measurements[field] !== 'string') {
            return false;
        }
    }

    return true;
}

async function getDeviceConnectionString(context, device) {
    const deviceId = device.deviceId;

    if (deviceCache[deviceId] && deviceCache[deviceId].connectionString) {
        return deviceCache[deviceId].connectionString;
    }

    const connStr = `HostName=${await getDeviceHub(context, device)};DeviceId=${deviceId};SharedAccessKey=${await getDeviceKey(context, deviceId)}`;
    deviceCache[deviceId].connectionString = connStr;
    return connStr;
}

/**
 * Registers this device with DPS, returning the IoT Hub assigned to it.
 */
async function getDeviceHub(context, device) {
    const deviceId = device.deviceId;
    const now = Date.now();

    // A 1 minute backoff is enforced for registration attempts, to prevent unauthorized devices
    // from trying to re-register too often.
    if (deviceCache[deviceId] && deviceCache[deviceId].lasRegisterAttempt && (now - deviceCache[deviceId].lasRegisterAttempt) < minDeviceRegistrationTimeout) {
        const backoff = Math.floor((minDeviceRegistrationTimeout - (now - deviceCache[deviceId].lasRegisterAttempt)) / 1000);
        throw new StatusError(`Unable to register device ${deviceId}. Minimum registration timeout not yet exceeded. Please try again in ${backoff} seconds`, 403);
    }

    deviceCache[deviceId] = {
        ...deviceCache[deviceId],
        lasRegisterAttempt: Date.now()
    }

    const sasToken = await getRegistrationSasToken(context, deviceId);
    const bodyJson = {
        registrationId: deviceId
    };
    if (device.gatewayId) {
        bodyJson["data"] = {
            iotcGateway: {
                iotcGatewayId: device.gatewayId,
                iotcIsGateway: false
            }
        }
    }

    const registrationOptions = {
        url: `https://${registrationHost}/${context.idScope}/registrations/${deviceId}/register?api-version=${registrationApiVersion}`,
        method: 'PUT',
        json: true,
        headers: { Authorization: sasToken },
        body: bodyJson,
    };

    try {
        context.log('[HTTP] Initiating device registration');
        const response = await request(registrationOptions);

        if (response.status !== 'assigning' || !response.operationId) {
            throw new Error('Unknown server response');
        }

        const statusOptions = {
            url: `https://${registrationHost}/${context.idScope}/registrations/${deviceId}/operations/${response.operationId}?api-version=${registrationApiVersion}`,
            method: 'GET',
            json: true,
            headers: { Authorization: sasToken }
        };

        // The first registration call starts the process, we then query the registration status
        // up to 4 times.
        for (const timeout of [...registrationRetryTimeouts, 0 /* Fail right away after the last attempt */]) {
            context.log('[HTTP] Querying device registration status');
            const statusResponse = await request(statusOptions);

            if (statusResponse.status === 'assigning') {
                await new Promise(resolve => setTimeout(resolve, timeout));
            } else if (statusResponse.status === 'assigned' && statusResponse.registrationState && statusResponse.registrationState.assignedHub) {
                return statusResponse.registrationState.assignedHub;
            } else if (statusResponse.status === 'failed' && statusResponse.registrationState && statusResponse.registrationState.errorCode === 400209) {
                throw new StatusError('The device may be unassociated or blocked', 403);
            } else {
                throw new Error('Unknown server response');
            }
        }

        throw new Error('Registration was not successful after maximum number of attempts');
    } catch (e) {
        throw new StatusError(`Unable to register device ${deviceId}: ${e.message}`, e.statusCode);
    }
}

async function getRegistrationSasToken(context, deviceId) {
    const uri = encodeURIComponent(`${context.idScope}/registrations/${deviceId}`);
    const ttl = Math.round(Date.now() / 1000) + registrationSasTtl;
    const signature = crypto.createHmac('sha256', new Buffer(await getDeviceKey(context, deviceId), 'base64'))
        .update(`${uri}\n${ttl}`)
        .digest('base64');
    return `SharedAccessSignature sr=${uri}&sig=${encodeURIComponent(signature)}&skn=registration&se=${ttl}`;
}

/**
 * Computes a derived device key using the primary key.
 */
async function getDeviceKey(context, deviceId) {
    if (deviceCache[deviceId] && deviceCache[deviceId].deviceKey) {
        return deviceCache[deviceId].deviceKey;
    }

    const key = crypto.createHmac('SHA256', Buffer.from(await context.getSecret(context, context.primaryKeyUrl), 'base64'))
        .update(deviceId)
        .digest()
        .toString('base64');

    deviceCache[deviceId].deviceKey = key;
    return key;
}