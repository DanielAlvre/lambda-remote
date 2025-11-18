const {info, error} = require('../config/logger.js');
const AWS = require('aws-sdk');
const ssm = new AWS.SSM();
const s3 = new AWS.S3(); // Inicializar el cliente S3 para listar

// --- CONSTANTES DE CONFIGURACIÓN --
const S3_BUCKET_NAME = 'proyecto-lsm-lengua-senas';
const S3_SOURCE_BASE_URL = 's3://' + S3_BUCKET_NAME + '/csv/'; // Destino: s3://proyecto-lsm-lengua-senas/csv/
const S3_BACKUP_BASE_URL = 's3://' + S3_BUCKET_NAME + '/backup/'; // Origen: s3://proyecto-lsm-lengua-senas/backup/
// INSTANCIA EC2 OBJETIVO FIJA
const EC2_INSTANCE_ID = 'i-0ddf9422fa1820c42'; // ID Fijo de tu servidor EC2
// ------------------------------------


/**
 * 1. DISCOVER: Busca todas las carpetas de palabras en la ruta S3 Backup
 * 2. ORCHESTRATE: Crea un único comando SSM para mover los archivos de vuelta a S3 Source.
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 * @returns {Promise<Object>} - Datos del comando SSM iniciado (CommandId)
 */
const startRollbackHandler = async (event) => {

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
        const singleWordCommand = [
            `aws s3 mv ${s3BackupPath} ${s3SourcePath} --recursive --exclude \"*\" --include \"*.csv\" --metadata-directive COPY`
        ].join(' && ');

        commands.push(singleWordCommand);
    });

    // 3. ENVIAR A SSM
    const finalCommand = commands.join(' && ');

    const params = {
        DocumentName: 'AWS-RunShellScript',
        InstanceIds: [EC2_INSTANCE_ID],
        Parameters: { commands: [finalCommand] },
        TimeoutSeconds: 60,
        CloudWatchOutputConfig: { // <-- Agregar este bloque
            CloudWatchLogGroupName: "/ssm/training-jobs",
            CloudWatchOutputEnabled: true
        }
    };

    info(`[S3-ROLLBACK] Enviando SSM a ${EC2_INSTANCE_ID}. Restaurando: ${words.join(', ')}`);
    const commandResult = await ssm.sendCommand(params).promise();

    return {
        message: `Comando de Rollback (restauración de ${words.length} palabras en S3) iniciado exitosamente.`,
        CommandId: commandResult.Command.CommandId,
        InstanceId: EC2_INSTANCE_ID,
        WordsRestored: words
    };
};

module.exports = {
    startRollbackHandler
};