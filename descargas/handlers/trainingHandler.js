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
// Comandos a ejecutar (inline) vía SSM.
// IMPORTANTE: Ejecutamos el bloque de entrenamiento como el usuario 'ubuntu' en un login shell,
// ya que SSM corre como root no interactivo y no carga correctamente el entorno de CUDA/venv.
const COMMANDS = [
    '#!/bin/bash',
    'set -euo pipefail',
    'echo "=== 🚀 Iniciando entrenamiento (SSM) ==="',
    'cat <<\'EOSUB\' > /tmp/train_as_ubuntu.sh',
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'cd /home/ubuntu/entrenador',
    // Evitar /etc/profile (byobu puede fallar con nounset). Cargar perfiles de usuario con protección.
    'if [ -f ~/.profile ]; then set +u; source ~/.profile || true; set -u; fi',
    'if [ -f ~/.bashrc ]; then set +u; source ~/.bashrc || true; set -u; fi',
    'source venv/bin/activate || { echo "VENV NO ENCONTRADA"; exit 1; }',
    'for i in {1..12}; do if nvidia-smi > /dev/null 2>&1; then echo "GPU OK"; break; fi; echo "Esperando GPU..."; sleep 5; done',
    'nvidia-smi || true',
    'PY_BIN=python',
    'which "$PY_BIN" || true',
    '$PY_BIN - <<\'PY\'',
    'import sys',
    'print(sys.version)',
    'print(sys.executable)',
    'PY',
    'VENV_SITE=$($PY_BIN - <<\'PY\'',
    'import site; print(site.getsitepackages()[0])',
    'PY',
    ')',
    '# Visibilidad y carga de librerías',
    'export CUDA_VISIBLE_DEVICES=0',
    'export TF_FORCE_GPU_ALLOW_GROWTH=true',
    // Aumentar batch y habilitar mixed precision para aprovechar GPU
    'export BATCH_SIZE=${BATCH_SIZE:-512}',
    'export MIXED_PRECISION=${MIXED_PRECISION:-1}',
    'export LD_LIBRARY_PATH="$VENV_SITE/nvidia/cudnn/lib:$VENV_SITE/nvidia/cublas/lib:$VENV_SITE/nvidia/cuda_runtime/lib:$VENV_SITE/nvidia/cufft/lib:$VENV_SITE/nvidia/curand/lib:$VENV_SITE/nvidia/cusolver/lib:$VENV_SITE/nvidia/cusparse/lib:$VENV_SITE/nvidia/nccl/lib:/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu:/usr/local/cuda-12.2/lib64:/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}"',
    'echo "LD_LIBRARY_PATH=$LD_LIBRARY_PATH"',
    'echo "ENV: BATCH_SIZE=$BATCH_SIZE MIXED_PRECISION=$MIXED_PRECISION"',
    'echo "=== Verificación TF/GPU previa al entrenamiento ==="',
    '$PY_BIN - <<\'PY\'',
    'import tensorflow as tf',
    'print("TF:", tf.__version__)',
    'print("Built with CUDA:", tf.test.is_built_with_cuda())',
    'print("Physical GPUs:", tf.config.list_physical_devices("GPU"))',
    'print("Logical GPUs:", tf.config.list_logical_devices("GPU"))',
    'PY',
    'echo "=== Ejecutando entrenamiento ==="',
    'timeout 2h $PY_BIN run_training.py || EXIT_CODE=$? || true',
    'EXIT_CODE=${EXIT_CODE:-0}',
    'if [ -n "$VIRTUAL_ENV" ]; then deactivate || true; fi',
    'echo "=== (ubuntu) Finalizado con código: $EXIT_CODE ==="',
    'exit $EXIT_CODE',
    'EOSUB',
    'chmod +x /tmp/train_as_ubuntu.sh',
    'EXIT_CODE=0',
    'sudo -iu ubuntu bash -lc "/tmp/train_as_ubuntu.sh" || EXIT_CODE=$? || true',
    'EXIT_CODE=${EXIT_CODE:-0}',
    'echo "=== Finalizado con código: $EXIT_CODE ==="',
    '# Opcional: apagar instancia',
    'sudo shutdown -h now'
];
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
    info(`[SSM] Enviando comandos de entrenamiento a ${EC2_INSTANCE_ID}`);

    const params = {
        DocumentName: 'AWS-RunShellScript',
        InstanceIds: [EC2_INSTANCE_ID],
        Parameters: { commands: COMMANDS },
        // Tiempo de espera aumentado a 2h + margen
        TimeoutSeconds: 7500,

        // 💥 NUEVO BLOQUE PARA LOGS EN CLOUDWATCH 💥
        CloudWatchOutputConfig: {
            CloudWatchLogGroupName: "/ssm/training-jobs", // Elige un nombre para tu grupo de logs
            CloudWatchOutputEnabled: true
        }
    };

    const commandResult = await ssm.sendCommand(params).promise();

    info(`--- ✅ Entrenamiento iniciado. CommandId: ${commandResult.Command.CommandId} ---`);

    return {
        message: `Comandos de Entrenamiento enviados a EC2 (timeout 2h).`,
        CommandId: commandResult.Command.CommandId,
        InstanceId: EC2_INSTANCE_ID,
        CommandsLength: COMMANDS.length
    };
}

module.exports = {
    startTrainingHandler
};