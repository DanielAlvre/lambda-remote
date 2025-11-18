const {info, error, debug} = require('./config/logger.js');
const {startDownloadHandler} = require('./handlers/downloadHandler');
const {startRollbackHandler} = require('./handlers/rollbackHandler'); // Handler de Rollback por SSM/EC2 (ruta: /rollback)
const {startTrainingHandler} = require('./handlers/trainingHandler');
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
 * Handler principal para la función Lambda que actúa como router.
 * Distribuye las peticiones a los handlers específicos (/download-start, /rollback, /rollback-s3).
 */
exports.handler = async (event, context) => {
    const startTime = new Date();
    const requestId = context.awsRequestId;
    let result = {};
    let operacion = 'desconocida';

    try {
        const httpMethod = event.httpMethod;
        const path = event.path;

        info(`Petición recibida: ${httpMethod} ${path}`, { requestId });

        // --- ROUTING BASADO EN RUTA Y MÉTODO ---
        if (httpMethod === 'GET' && path.includes('/download-start')) {
            // RUTA 1: Iniciar Descarga a EC2 y Backup en S3 (Usa downloadHandler.js)
            operacion = 'iniciar_descarga_ssm_backup';
            const data = await startDownloadHandler(event);
            result = createSuccessResponse(202, data); // 202: Accepted -> La tarea fue aceptada y se está procesando

        } else if (httpMethod === 'GET' && path.includes('/rollback-ssm')) { // RUTA RENOMBRADA a /rollback-ssm en template.yaml
            // RUTA 2: Iniciar Rollback CLÁSICO (SSM/EC2) (Usa rollbackHandler.js)
            operacion = 'iniciar_rollback_ssm';
            const data = await startRollbackHandler(event);
            result = createSuccessResponse(202, data);

        } else if (httpMethod === 'GET' && path.includes('/start-training')) {
            // 🆕 RUTA 3: Iniciar Entrenamiento (Usa trainingHandler.js)
            operacion = 'iniciar_entrenamiento_ec2';
            // Notamos que la función ahora solo necesita 'event'
            const data = await startTrainingHandler(event, context);
            result = createSuccessResponse(202, data);
        }
        else {
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