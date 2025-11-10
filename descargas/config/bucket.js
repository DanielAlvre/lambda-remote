const { info, error } = require('./logger');
const { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const AWS = require('aws-sdk');

// Definir la región (puedes obtenerla de variables de entorno o usar una por defecto)
const region = process.env.AWS_REGION || 'us-east-1';

const bucketSecretId = 'bucket'; // Nombre fijo del secreto
let cachedBucketName = null;
let s3Client = null;

function getS3Client() {
    if (!s3Client) {
        s3Client = new S3Client({ region });
    }
    return s3Client;
}

/**
 * Obtiene el nombre del bucket desde AWS Secrets Manager
 * @returns {Promise<string>} El nombre del bucket
 */
async function getBucketNameFromSecrets() {
    // Usar caché si ya tenemos el nombre del bucket
    if (cachedBucketName) {
        return cachedBucketName;
    }

    try {
        info(`Obteniendo nombre de bucket desde Secrets Manager: ${bucketSecretId}`);

        const sm = new AWS.SecretsManager({ region });
        const result = await sm.getSecretValue({ SecretId: bucketSecretId }).promise();
        info(result);
        const { SecretString, SecretBinary } = result;
        let raw = SecretString;

        if (!raw && SecretBinary) {
            raw = Buffer.from(SecretBinary, 'base64').toString('ascii');
        }

        if (!raw) {
            throw new Error('Secreto vacío en Secrets Manager');
        }

        const bucketName = raw.trim();

        if (!bucketName || typeof bucketName !== 'string') {
            throw new Error('Formato de nombre de bucket inválido en Secrets Manager');
        }

        cachedBucketName = bucketName;
        info(`Nombre de bucket obtenido desde Secrets Manager: ${bucketName}`);
        return bucketName;

    } catch (err) {
        error('Error obteniendo nombre de bucket desde Secrets Manager: ' + err.message);
        throw new Error(`Error cargando bucket desde Secrets Manager: ${err.message}`);
    }
}

/**
 * Lista objetos en el bucket
 * @param {string} bucket - El nombre del bucket (opcional, usa el por defecto si no se proporciona)
 * @param {string} prefix - Prefijo para filtrar objetos (opcional)
 * @param {number} maxKeys - Número máximo de objetos a retornar (opcional, máximo 1000)
 * @returns {Promise<Object>} La respuesta con la lista de objetos
 */
async function listObjects(bucket = null, prefix = '', maxKeys = 1000) {
    try {
        const bucketName = bucket || await getBucketNameFromSecrets();

        const s3Client = getS3Client();
        const listParams = {
            Bucket: bucketName,
            MaxKeys: Math.min(maxKeys, 1000)
        };

        if (prefix) {
            listParams.Prefix = prefix;
        }

        info(`Listando objetos en bucket ${bucketName}${prefix ? ` con prefijo: ${prefix}` : ''}`);
        const listCommand = new ListObjectsV2Command(listParams);
        const result = await s3Client.send(listCommand);

        info(`Encontrados ${result.Contents?.length || 0} objetos en bucket ${bucketName}`);
        return result;

    } catch (err) {
        error(`Error listando objetos en bucket:`, err);
        throw new Error(`Error listando objetos: ${err.message}`);
    }
}

/**
 * Obtiene la URL de un objeto en el bucket (construcción directa sin AWS call)
 * @param {string} key - La clave del objeto
 * @param {string} bucket - El nombre del bucket (opcional, usa el por defecto si no se proporciona)
 * @returns {Promise<string>} La URL del objeto
 */
async function getObjectUrl(key, bucket = null) {
    const bucketName = bucket || await getBucketNameFromSecrets();

    if (!key) {
        throw new Error('La clave del objeto es requerida');
    }

    return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Sube un archivo al bucket
 * @param {Buffer|string} fileContent - El contenido del archivo como Buffer o string
 * @param {string} key - La clave del objeto (nombre del archivo)
 * @param {string} contentType - El tipo de contenido del archivo
 * @param {string} bucket - El nombre del bucket (opcional, usa el por defecto si no se proporciona)
 * @param {Object} metadata - Metadatos adicionales (opcional)
 * @returns {Promise<Object>} La respuesta de la subida
 */
async function uploadFile(fileContent, key, contentType = 'application/octet-stream', bucket = null, metadata = {}) {
    try {
        const bucketName = bucket || await getBucketNameFromSecrets();

        if (!fileContent) {
            throw new Error('El contenido del archivo es requerido');
        }

        if (!key) {
            throw new Error('La clave del objeto es requerida');
        }

        const s3Client = getS3Client();
        const uploadParams = {
            Bucket: bucketName,
            Key: key,
            Body: fileContent,
            ContentType: contentType
        };

        // Agregar metadatos si se proporcionan
        if (Object.keys(metadata).length > 0) {
            uploadParams.Metadata = metadata;
        }

        info(`Subiendo archivo ${key} al bucket ${bucketName} con tipo de contenido ${contentType}`);
        const putCommand = new PutObjectCommand(uploadParams);
        const result = await s3Client.send(putCommand);

        info(`Archivo ${key} subido exitosamente al bucket ${bucketName}`);

        return {
            ...result,
            Location: await getObjectUrl(key, bucketName),
            Bucket: bucketName,
            Key: key
        };

    } catch (err) {
        error(`Error subiendo archivo ${key}:`, err);
        throw new Error(`Error subiendo archivo: ${err.message}`);
    }
}

/**
 * Verifica si un objeto existe en el bucket
 * @param {string} key - La clave del objeto
 * @param {string} bucket - El nombre del bucket (opcional, usa el por defecto si no se proporciona)
 * @returns {Promise<boolean>} true si el objeto existe, false si no existe
 */
async function checkObjectExists(key, bucket = null) {
    try {
        const bucketName = bucket || await getBucketNameFromSecrets();

        if (!key) {
            throw new Error('La clave del objeto es requerida');
        }

        const s3Client = getS3Client();
        const headParams = {
            Bucket: bucketName,
            Key: key
        };

        const headCommand = new HeadObjectCommand(headParams);
        await s3Client.send(headCommand);
        return true;

    } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            return false;
        }
        error(`Error verificando existencia del archivo ${key}:`, err);
        throw new Error(`Error verificando existencia del archivo: ${err.message}`);
    }
}

/**
 * Elimina un objeto del bucket
 * @param {string} key - La clave del objeto
 * @param {string} bucket - El nombre del bucket (opcional, usa el por defecto si no se proporciona)
 * @returns {Promise<Object>} La respuesta de la eliminación
 */
async function deleteObject(key, bucket = null) {
    try {
        const bucketName = bucket || await getBucketNameFromSecrets();

        if (!key) {
            throw new Error('La clave del objeto es requerida');
        }

        const s3Client = getS3Client();
        const deleteParams = {
            Bucket: bucketName,
            Key: key
        };

        info(`Eliminando archivo ${key} del bucket ${bucketName}`);
        const deleteCommand = new DeleteObjectCommand(deleteParams);
        const result = await s3Client.send(deleteCommand);

        info(`Archivo ${key} eliminado exitosamente del bucket ${bucketName}`);
        return result;

    } catch (err) {
        error(`Error eliminando archivo ${key}:`, err);
        throw new Error(`Error eliminando archivo: ${err.message}`);
    }
}

module.exports = {
    getBucketNameFromSecrets,
    listObjects,
    getObjectUrl,
    uploadFile,
    deleteObject,
    checkObjectExists,
};