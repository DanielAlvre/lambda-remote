const AWS = require('aws-sdk');
const ssm = new AWS.SSM();
const ec2 = new AWS.EC2(); // Cliente EC2 para gestión de instancias

// Usamos console.log/error para emular el logger (ajusta si usas un logger personalizado)
const info = console.log;
const error = console.error;

// --- CONSTANTES DE CONFIGURACIÓN ---
// INSTANCIA EC2 OBJETIVO FIJA
const EC2_INSTANCE_ID = 'i-0ddf9422fa1820c42'; // ID Fijo de tu servidor EC2
// Ruta donde se encuentra el script run_training.py
const EC2_TRAINING_PATH = '/home/ubuntu/entrenador/';
// Comando final a ejecutar
const COMMAND_TO_EXECUTE = `cd ${EC2_TRAINING_PATH} && python3 run_training.py; sudo shutdown -h now`
// ------------------------------------

/**
 * Espera un número de milisegundos.
 * @param {number} ms - Milisegundos a esperar.
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Revisa el estado de la instancia EC2 y la inicia si está detenida.
 * Espera hasta que la instancia esté en estado 'running'.
 * @param {string} instanceId - ID de la instancia EC2.
 */
async function checkAndStartInstance(instanceId) {
    info(`[EC2] Verificando estado de la instancia ${instanceId}...`);

    let instanceState = '';
    const MAX_ATTEMPTS = 15;
    let attempt = 0;

    while (instanceState !== 'running' && attempt < MAX_ATTEMPTS) {
        attempt++;

        const describeParams = { InstanceIds: [instanceId] };
        const data = await ec2.describeInstances(describeParams).promise();

        const instance = data.Reservations[0]?.Instances[0];

        if (!instance) {
            error(`[EC2] Error: No se encontró la instancia con ID ${instanceId}.`);
            throw new Error(`InstanceNotFound: La instancia EC2 ${instanceId} no existe.`);
        }

        instanceState = instance.State.Name;
        info(`[EC2] Intento ${attempt}: Estado actual: ${instanceState}`);

        if (instanceState === 'stopped') {
            info(`[EC2] Instancia detenida. Iniciando instancia ${instanceId}...`);
            await ec2.startInstances({ InstanceIds: [instanceId] }).promise();
            instanceState = 'pending';
        } else if (instanceState === 'pending' || instanceState === 'stopping') {
            info(`[EC2] Instancia en estado de transición (${instanceState}). Esperando 10 segundos...`);
            await sleep(10000);
        } else if (instanceState === 'running') {
            info(`[EC2] Instancia ${instanceId} está lista y corriendo.`);
            return;
        } else {
            error(`[EC2] Estado inesperado: ${instanceState}. No se puede proceder.`);
            throw new Error(`EC2StateError: La instancia EC2 está en estado ${instanceState} y no puede ser utilizada.`);
        }
    }

    if (instanceState !== 'running') {
        error(`[EC2] Fallo al iniciar la instancia ${instanceId} después de ${MAX_ATTEMPTS} intentos.`);
        throw new Error(`EC2Timeout: La instancia EC2 no pudo alcanzar el estado 'running' a tiempo.`);
    }
}


/**
 * HANDLER PRINCIPAL: Orquestador de Entrenamiento.
 * 1. Asegura que la instancia EC2 esté encendida.
 * 2. Envía un comando SSM para ejecutar el script de entrenamiento de Python.
 */
async function startTrainingHandler(event, context) {
    info('--- INICIANDO ORQUESTADOR DE ENTRENAMIENTO ---');

    // --- PASO 1: CHEQUEAR Y ARRANCAR INSTANCIA EC2 ---
    await checkAndStartInstance(EC2_INSTANCE_ID);

    // --- PASO 2: ENVIAR COMANDO DE ENTRENAMIENTO A SSM ---
    info(`[SSM] Enviando comando de entrenamiento a ${EC2_INSTANCE_ID}: ${COMMAND_TO_EXECUTE}`);

    const params = {
        DocumentName: 'AWS-RunShellScript',
        InstanceIds: [EC2_INSTANCE_ID],
        Parameters: { commands: [COMMAND_TO_EXECUTE] },
        TimeoutSeconds: 3600, // 1 hora

        // 💥 NUEVO BLOQUE PARA LOGS EN CLOUDWATCH 💥
        CloudWatchOutputConfig: {
            CloudWatchLogGroupName: "/ssm/training-jobs", // Elige un nombre para tu grupo de logs
            CloudWatchOutputEnabled: true
        }
    };

    const commandResult = await ssm.sendCommand(params).promise();

    info(`--- ✅ Entrenamiento iniciado. CommandId: ${commandResult.Command.CommandId} ---`);

    return {
        message: `Comando de Entrenamiento (python3 run_training.py) enviado a EC2.`,
        CommandId: commandResult.Command.CommandId,
        InstanceId: EC2_INSTANCE_ID,
        CommandExecuted: COMMAND_TO_EXECUTE
    };
}

module.exports = {
    startTrainingHandler
};