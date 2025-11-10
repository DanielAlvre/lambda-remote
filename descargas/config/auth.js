const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const { info, warn, error, debug } = require('./logger');

// Simple in-memory cache across Lambda warm invocations
let cachedSecret = null;
let cachedAt = 0;
let loadingPromise = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getJwtSecret() {
    // Usar el mismo patrón que en tu generador de tokens
    const secretId = process.env.SECRET_NAME || 'lambda-crud/jwt-secret';

    const now = Date.now();
    if (cachedSecret && (now - cachedAt) < CACHE_TTL_MS) {
        debug({ message: 'Usando secreto JWT desde cache', ageMs: now - cachedAt });
        return cachedSecret;
    }

    if (!loadingPromise) {
        const sm = new AWS.SecretsManager();
        loadingPromise = sm.getSecretValue({ SecretId: secretId }).promise()
            .then((res) => {
                const { SecretString, SecretBinary } = res;
                let raw = SecretString;
                if (!raw && SecretBinary) {
                    raw = Buffer.from(SecretBinary, 'base64').toString('ascii');
                }
                if (!raw) throw new Error('Secreto vacío');

                let secretValue;
                try {
                    const parsed = JSON.parse(raw);
                    // Prefer keys commonly used
                    secretValue = parsed.JWT_SECRET || parsed.jwt_secret || parsed.secret || parsed.value || raw;
                } catch {
                    secretValue = raw; // plain string secret
                }

                if (!secretValue || typeof secretValue !== 'string') {
                    throw new Error('Formato de secreto inválido');
                }

                cachedSecret = secretValue;
                cachedAt = Date.now();
                info('Secreto JWT cargado desde Secrets Manager');
                return cachedSecret;
            })
            .finally(() => {
                // allow subsequent refreshes to reenter on expiry
                setTimeout(() => { loadingPromise = null; }, 0);
            });
    }

    return loadingPromise;
}

function getAuthHeader(event) {
    const headers = event.headers || {};
    // API Gateway can lowercase headers
    return headers.Authorization || headers.authorization || headers.AUTHORIZATION || '';
}

async function verifyJwtFromEvent(event) {
    const authHeader = getAuthHeader(event);
    if (!authHeader) {
        const err = new Error('Falta encabezado Authorization');
        err.statusCode = 401;
        throw err;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        const err = new Error('Formato de autorización inválido');
        err.statusCode = 401;
        throw err;
    }

    const token = parts[1];
    if (!token) {
        const err = new Error('Token no provisto');
        err.statusCode = 401;
        throw err;
    }

    const secret = await getJwtSecret();
    try {
        const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
        debug({ message: 'JWT verificado', sub: decoded.sub, scope: decoded.scope });
        return decoded;
    } catch (e) {
        warn({ message: 'JWT inválido', error: e.message });
        const err = new Error('Token inválido o expirado');
        err.statusCode = 401;
        throw err;
    }
}

module.exports = {
    getJwtSecret,
    verifyJwtFromEvent,
};