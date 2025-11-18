const {info, error} = require('../config/logger.js');
const AWS = require('aws-sdk');
const ssm = new AWS.SSM();
const s3 = new AWS.S3(); // Inicializar el cliente S3 para listar
const ec2 = new AWS.EC2(); // Cliente EC2 para gestión de instancias

// --- CONSTANTES DE CONFIGURACIÓN --
const S3_BUCKET_NAME = 'proyecto-lsm-lengua-senas';
const S3_SOURCE_BASE_URL = 's3://' + S3_BUCKET_NAME + '/csv/'; // Destino: s3://proyecto-lsm-lengua-senas/csv/
const S3_BACKUP_BASE_URL = 's3://' + S3_BUCKET_NAME + '/backup/'; // Origen: s3://proyecto-lsm-lengua-senas/backup/
// INSTANCIA EC2 OBJETIVO FIJA
const EC2_INSTANCE_ID = 'i-0ddf9422fa1820c42'; // ID Fijo de tu servidor EC2
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
 * 1. DISCOVER: Busca todas las carpetas de palabras en la ruta S3 Backup
 * 2. ORCHESTRATE: Crea un único comando SSM para mover los archivos de vuelta a S3 Source.
 * 3. EXECUTE: Envía el comando SSM para ejecutar el rollback y apagar la instancia.
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 * @returns {Promise<Object>} - Datos del comando SSM iniciado (CommandId)
 */
const startRollbackHandler = async (event) => {

    info('--- INICIANDO rollback de palabras en S3 ---');

    // --- PASO 1: CHEQUEAR Y ARRANCAR INSTANCIA EC2 ---
    await checkAndStartInstance(EC2_INSTANCE_ID);


    // 1. DISCOVER: Obtener la lista de carpetas de palabras en la carpeta de backup
    const listParams = {
        Bucket: S3_BUCKET_NAME,
        Prefix: S3_BACKUP_BASE_URL.replace(`s3://${S3_BUCKET_NAME}/`, ''), // "backup/"
        Delimiter: '/'
    };

    info(`[S3-DISCOVERY] Listando carpetas de palabras en s3://${S3_BUCKET_NAME}/${listParams.Prefix}`);

    const response = await s3.listObjectsV2(listParams).promise();

    // Filtra los CommonPrefixes para obtener solo los nombres de las palabras (ej: 'agua', 'hola')
    const words = (response.CommonPrefixes || [])
        .map(p => p.Prefix.replace(listParams.Prefix, '').replace('/', ''))
        .filter(word => word.length > 0);

    if (words.length === 0) {
        return {
            message: 'No se encontraron carpetas con archivos de backup para restaurar.'
        };
    }

    info(`[S3-DISCOVERY] Palabras encontradas para restaurar: ${words.join(', ')}`);

    // 2. ORCHESTRATE: Construir el comando SSM combinado
    const commands = [];
    words.forEach(word => {
        const s3SourcePath = `${S3_SOURCE_BASE_URL}${word}/`;       // Destino: s3://.../csv/agua/
        const s3BackupPath = `${S3_BACKUP_BASE_URL}${word}/`; // Origen: s3://.../backup/agua/

        // Comando para una palabra: Mover archivos DESDE S3 Backup HACIA S3 Source
        // Se usa --metadata-directive COPY para mantener el timestamp de modificación, lo cual es útil.
        const singleWordCommand = [
            `aws s3 mv ${s3BackupPath} ${s3SourcePath} --recursive --exclude \"*\" --include \"*.csv\" --metadata-directive COPY`
        ].join(' && ');

        commands.push(singleWordCommand);
    });

    // 3. ENVIAR A SSM
    const rollbackCommands = commands.join(' && ');
    const shutdownCommand = `sudo shutdown -h now`;

    // El comando final ejecuta los movimientos de S3, y si son exitosos (&&), apaga la máquina
    const finalCommand = `${rollbackCommands} && ${shutdownCommand}`; // <-- Apagado añadido aquí

    const params = {
        DocumentName: 'AWS-RunShellScript',
        InstanceIds: [EC2_INSTANCE_ID],
        Parameters: { commands: [finalCommand] },
        TimeoutSeconds: 60,
        CloudWatchOutputConfig: {
            CloudWatchLogGroupName: "/ssm/training-jobs",
            CloudWatchOutputEnabled: true
        }
    };

    info(`[S3-ROLLBACK] Enviando SSM a ${EC2_INSTANCE_ID}. Restaurando: ${words.join(', ')} y apagando.`);
    const commandResult = await ssm.sendCommand(params).promise();

    return {
        message: `Comando de Rollback (restauración de ${words.length} palabras en S3) iniciado exitosamente, con apagado automático.`,
        CommandId: commandResult.Command.CommandId,
        InstanceId: EC2_INSTANCE_ID,
        WordsRestored: words
    };
};

module.exports = {
    startRollbackHandler
};