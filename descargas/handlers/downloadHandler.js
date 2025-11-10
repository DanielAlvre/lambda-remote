const {info, error} = require('../config/logger.js');
const AWS = require('aws-sdk');
const ssm = new AWS.SSM();
// Inicializar el cliente S3 para listar los contenidos
const s3 = new AWS.S3();

// --- CONSTANTES DE CONFIGURACIÓN ---
const S3_BASE_URL = 's3://proyecto-lsm-lengua-senas/csv/';
const S3_BACKUP_PREFIX = 'backup/';
const EC2_LOCAL_BASE = '/home/ubuntu/sign_language_project/data/csv/';

// INSTANCIA EC2 OBJETIVO FIJA (TU SERVIDOR DE ENTRENAMIENTO)
const EC2_INSTANCE_ID = 'i-0150b0df086b5f6a2';
// ------------------------------------

// Valores derivados de las constantes S3
const S3_BUCKET_NAME = 'proyecto-lsm-lengua-senas';
const S3_SOURCE_PREFIX = 'csv/';


/**
 * HANDLER DE LÓGICA: Descubre automáticamente las carpetas de palabras en S3
 * bajo el prefijo 'csv/', e inicia la descarga masiva y el proceso de backup.
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 * @returns {Promise<Object>} - Datos del comando SSM iniciado (CommandId)
 */
const startDownloadHandler = async (event) => {
    // 1. DISCOVER: Obtener la lista de carpetas de palabras directamente de S3

    const listParams = {
        Bucket: S3_BUCKET_NAME,
        Prefix: S3_SOURCE_PREFIX,
        Delimiter: '/' // Usamos el delimitador para listar solo las subcarpetas (prefijos comunes)
    };

    info(`[S3-DISCOVERY] Listando carpetas de palabras en s3://${S3_BUCKET_NAME}/${S3_SOURCE_PREFIX}`);

    let listData;
    try {
        listData = await s3.listObjectsV2(listParams).promise();
    } catch (err) {
        error('Error al listar objetos de S3:', err);
        throw new Error(`Error al conectar o listar el bucket S3: ${err.message}`);
    }

    // Obtener las palabras/carpetas (CommonPrefixes) y limpiar el prefijo base.
    const words = listData.CommonPrefixes
        .map(prefixObj => {
            // Ejemplo: 'csv/agua/' -> 'agua'
            return prefixObj.Prefix.replace(S3_SOURCE_PREFIX, '').replace('/', '');
        })
        // 2. FILTER: Excluir la carpeta de backup del proceso de descarga
        .filter(word => word.length > 0 && word !== S3_BACKUP_PREFIX.replace('/', ''));


    if (words.length === 0) {
        const err = new Error(`No se encontraron carpetas de palabras válidas en s3://${S3_BUCKET_NAME}/${S3_SOURCE_PREFIX}.`);
        err.statusCode = 404;
        throw err;
    }

    info(`[S3-DISCOVERY] Palabras encontradas para procesar: ${words.join(', ')}`);

    let commands = [];
    let commandSummary = [];

    // 3. GENERATE: Iterar sobre cada palabra descubierta para construir el comando
    words.forEach(word => {
        const s3SourcePath = `${S3_BASE_URL}${word}/`;
        const s3BackupPath = `${S3_BASE_URL}${S3_BACKUP_PREFIX}${word}/`;
        const localPath = `${EC2_LOCAL_BASE}${word}/`; // Ruta local en EC2

        // Script de Shell: mkdir, sync, y mv (backup) para la palabra actual
        const singleWordCommand = [
            // 1. Crear la carpeta local
            `mkdir -p ${localPath}`,
            // 2. Descargar el contenido (solo CSV)
            `aws s3 sync ${s3SourcePath} ${localPath} --exclude "*" --include "*.csv"`,
            // 3. Mover el contenido de S3 Source a S3 Backup (Backup)
            `aws s3 mv ${s3SourcePath} ${s3BackupPath} --recursive --exclude "*" --include "*.csv" --metadata-directive COPY`
        ].join(' && ');

        commands.push(singleWordCommand);
        commandSummary.push(word);
    });

    // 4. ORCHESTRATE: Unir todos los comandos individuales con ' && ' y enviar a SSM
    const finalCommand = commands.join(' && ');

    // Configurar y enviar a SSM
    const params = {
        DocumentName: 'AWS-RunShellScript',
        InstanceIds: [EC2_INSTANCE_ID],
        Parameters: { commands: [finalCommand] },
        TimeoutSeconds: 3600
    };

    info(`[DOWNLOAD/S3-BACKUP] Enviando SSM a ${EC2_INSTANCE_ID}. Procesando: ${commandSummary.join(', ')}`);
    const commandResult = await ssm.sendCommand(params).promise();

    return {
        message: `Proceso de descarga y backup iniciado exitosamente para ${words.length} palabras (descubrimiento automático).`,
        CommandId: commandResult.Command.CommandId,
        InstanceId: EC2_INSTANCE_ID,
        WordsProcessed: words, // Reportamos las palabras descubiertas
        ShellCommandStart: finalCommand.substring(0, 100) + "..." // Reporte truncado
    };
};

module.exports = { startDownloadHandler };