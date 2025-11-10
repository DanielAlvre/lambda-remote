const {info, error, debug} = require('./config/logger.js');
const {startDownloadHandler} = require('./handlers/downloadHandler');
const {startRollbackHandler} = require('./handlers/rollbackHandler');

// ========================================================================
// FUNCIONES DE RESPUESTA DE API GATEWAY
// ========================================================================

/**
 * Crea una respuesta de éxito estandarizada (incluye CORS)
 */
function createSuccessResponse(statusCode, data) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*', // Permitir peticiones desde cualquier origen
            'Access-Control-Allow-Credentials': true
        },
        body: JSON.stringify(data)
    };
}

/**
 * Crea una respuesta de error estandarizada (incluye CORS)
 */
function createErrorResponse(statusCode, message) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': true
        },
        body: JSON.stringify({
            error: message,
            timestamp: new Date().toISOString()
        })
    };
}

// ========================================================================
// HANDLER PRINCIPAL (LAMBDA ENTRY POINT)
// ========================================================================

/**
 * Handler principal para el API Gateway Lambda Proxy
 */
exports.handler = async (event, context) => {
    const startTime = new Date();
    const requestId = context?.awsRequestId;
    let result;

    try {
        const httpMethod = event?.httpMethod || 'GET';
        const path = event?.path || '/';
        let operacion = 'desconocida';

        info(`Iniciando request: ${httpMethod} ${path}`, { startTime, requestId, query: event.queryStringParameters });

        // Manejo de CORS preflight (OPTIONS)
        if (httpMethod === 'OPTIONS') {
            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET,OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key',
                    'Access-Control-Allow-Credentials': true
                },
                body: JSON.stringify({ok: true})
            };
        }

        // --- ROUTING BASADO EN RUTA Y MÉTODO ---
        if (httpMethod === 'GET' && path.includes('/download-start')) {
            // RUTA 1: Iniciar Descarga a EC2 y Backup en S3
            operacion = 'iniciar_descarga_s3_backup';
            const data = await startDownloadHandler(event);
            result = createSuccessResponse(202, data); // 202: Accepted -> La tarea fue aceptada y se está procesando

        } else if (httpMethod === 'GET' && path.includes('/rollback')) {
            // RUTA 2: Iniciar Rollback en S3
            operacion = 'iniciar_rollback_s3';
            const data = await startRollbackHandler(event);
            result = createSuccessResponse(202, data);

        } else {
            operacion = 'ruta_no_encontrada';
            result = createErrorResponse(404, `Ruta no encontrada: ${httpMethod} ${path}`);
        }

        const duration = new Date() - startTime;
        info(`Operación ${operacion} completada`, {
            duration: `${duration}ms`,
            statusCode: result.statusCode,
            requestId
        });

        return result;

    } catch (err) {
        const duration = new Date() - startTime;
        error(`Error en handler principal: ${err?.message}`, { startTime, requestId, stack: err.stack });

        // Si el error es un error de validación (statusCode 400), lo retornamos.
        // Si es un error desconocido, retornamos 500.
        const statusCode = err.statusCode || 500;
        return createErrorResponse(statusCode, err.message || 'Error interno del servidor');
    }
};