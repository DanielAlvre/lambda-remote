const winston = require('winston');
const path = require('path');
const util = require('util');

// ============================================================================
// 1. CONFIGURACIÓN DEL LOGGER
// ============================================================================

/**
 * Configura y crea el logger principal de Winston
 * - Nivel mínimo: debug (permite todos los niveles)
 * - Formato: solo muestra el mensaje sin metadata adicional
 * - Transporte: salida a consola
 */
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.printf(({ message }) => message),
    transports: [
        new winston.transports.Console()
    ]
});

// ============================================================================
// 2. FUNCIONES PRINCIPALES DE LOGGING
// ============================================================================

/**
 * Factory que crea funciones de logging para cada nivel
 * @param {string} level - Nivel de log (info, error, warn, debug)
 * @returns {Function} Función de logging personalizada
 */
const createLogFunction = (level) => (message, startTime = null, endTime = null) => {
    const logData = formatLogData(level, message, startTime, endTime);
    const timeInfo = logData.elapsedMs !== undefined ? ` | tiempo: ${logData.elapsedMs} ms` : '';
    logger[level](`[${logData.caller}] ${logData.message}${timeInfo}`);
};

// Funciones de logging específicas por nivel
const info = createLogFunction('info');
const error = createLogFunction('error');
const warn = createLogFunction('warn');
const debug = createLogFunction('debug');

// ============================================================================
// 3. FUNCIONES DE UTILIDAD PARA FORMATEO
// ============================================================================

/**
 * Formatea y estructura todos los datos necesarios para el log
 * @param {string} level - Nivel del log
 * @param {*} message - Mensaje a loggear (cualquier tipo)
 * @param {Date|null} startTime - Tiempo de inicio (opcional)
 * @param {Date|null} endTime - Tiempo de fin (opcional)
 * @returns {Object} Datos estructurados del log
 */
function formatLogData(level, message, startTime = null, endTime = null) {
    const logData = {
        level,
        caller: getCallerInfo(),
        message: stringifyMessage(message)
    };

    // Procesar tiempos si se proporcionan ambos
    if (startTime && endTime) {
        try {
            const start = startTime instanceof Date ? startTime : new Date(startTime);
            const end = endTime instanceof Date ? endTime : new Date(endTime);
            logData.startTime = start.toISOString();
            logData.endTime = end.toISOString();
            logData.elapsedMs = calculateElapsed(start, end);
        } catch (err) {
            console.error('Error al procesar tiempos de log:', err);
        }
    }

    return logData;
}

/**
 * Identifica el archivo desde donde se está llamando la función de log
 * Analiza el stack trace para encontrar el archivo origen (excluyendo logger.js)
 * @returns {string} Nombre del archivo que hizo la llamada al log
 */
function getCallerInfo() {
    const error = new Error();
    const stackLines = error.stack?.split('\n') || [];

    // Empezar desde línea 2 para saltar la creación del Error y esta función
    for (let i = 2; i < stackLines.length; i++) {
        const line = stackLines[i];

        // Patrones para diferentes formatos de stack trace
        const match = line.match(/at\s+(.*)\s+\((.*):(\d+):(\d+)\)/) ||
            line.match(/at\s+()(.*):(\d+):(\d+)/);

        if (match) {
            const fileName = path.basename(match[2] || '');
            // Ignorar el propio archivo de logger para encontrar el verdadero llamador
            if (fileName !== 'logger.js') {
                return fileName;
            }
        }
    }
    return 'Desconocido';
}

/**
 * Convierte cualquier tipo de dato en un string legible para el log
 * Maneja diferentes tipos: string, Error, objetos, etc.
 * @param {*} message - Mensaje de cualquier tipo
 * @returns {string} Mensaje convertido a string seguro
 */
function stringifyMessage(message) {
    try {
        // Si ya es string, devolverlo directamente
        if (typeof message === 'string') return message;

        // Si es Error, usar stack trace o mensaje
        if (message instanceof Error) return message.stack || message.message;

        // Para otros tipos, usar util.inspect() sin colores y en una línea
        return util.inspect(message, { depth: null, colors: false }).replace(/\n/g, ' ');
    } catch {
        return '[Error al serializar mensaje]';
    }
}

/**
 * Calcula la diferencia en milisegundos entre dos fechas
 * @param {Date} startTime - Fecha de inicio
 * @param {Date} endTime - Fecha de fin
 * @returns {number|null} Diferencia en milisegundos o null si faltan parámetros
 */
function calculateElapsed(startTime, endTime) {
    if (!startTime || !endTime) return null;
    return endTime.getTime() - startTime.getTime();
}

// ============================================================================
// 4. EXPORTACIONES
// ============================================================================

module.exports = {
    logger,    // Logger Winston original para uso avanzado
    info,      // Log nivel info
    error,     // Log nivel error
    warn,      // Log nivel warning
    debug      // Log nivel debug
};