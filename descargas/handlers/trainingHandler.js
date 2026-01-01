const AWS = require('aws-sdk');
const ssm = new AWS.SSM();
const ec2 = new AWS.EC2(); // Cliente EC2 para gestión de instancias

// Usamos console.log/error para emular el logger (ajusta si usas un logger personalizado)
const info = console.log;
const error = console.error;

// --- CONSTANTES DE CONFIGURACIÓN ---
// INSTANCIA EC2 OBJETIVO FIJA
const EC2_INSTANCE_ID = 'i-0ddf9422fa1820c42'; // ID Fijo de tu servidor EC2
// --- NUEVA CONSTRUCCIÓN DINÁMICA DE COMANDOS SEGÚN MODO ---
function getDefaultConfig() {
    return {
        BATCH_SIZE: 512,
        MIXED_PRECISION: 0,
        GPU_OPTIMIZED: 1,
        LSTM_LAYERS: 2,
        LSTM_UNITS: 16,
        DENSE_UNITS: 64,
        DROPOUT_RNN: 0.5,
        DROPOUT_DENSE: 0.6,
        L2_REG: 0.01,
        EARLY_STOPPING_PATIENCE: 8,
        EARLY_STOPPING_MIN_DELTA: 0.001,
        EPOCHS: 600,
        DATA_AUGMENTATION: 1,
        REMOVE_DUPLICATES: 1,
        AUGMENTATION_FACTOR: 2,
        TRAIN_SPLIT: 0.6,
        VAL_SPLIT: 0.2,
        TEST_SPLIT: 0.2,
        TRAINING_MODE: '1',
        RESTRICTED_LABELS: [],
        CANTIDAD: 0,
        TOMA_CANTIDA: false,
        MAX_SAMPLES_PER_SIGN: 0,
        AUTO_SHUTDOWN_ENABLED: false,
        CLEANUP_CSV_ENABLED: false
    };
}

function buildCommands(cfg) {
    const AUTO_SHUTDOWN_ENV = cfg.AUTO_SHUTDOWN_ENABLED ? '1' : '0';
    const CLEANUP_CSV_ENV = cfg.CLEANUP_CSV_ENABLED ? '1' : '0';

    const COMMANDS = [
        '#!/bin/bash',
        'set -euo pipefail',
        'echo "=== 🚀 Iniciando entrenamiento (SSM) ==="',
        'cat <<\'EOSUB\' > /tmp/train_as_ubuntu.sh',
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '# Redirigir toda la salida: truncar log previo y escribir sólo esta corrida',
        ': > /home/ubuntu/train.log',
        'exec > /home/ubuntu/train.log 2>&1',
        'echo "[TRAIN] ===== Inicio $(date -Iseconds) ====="',
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
        '# usersite del python del sistema para capturar ~/.local si hubiera paquetes nvidia instalados allí',
        'LOCAL_SITE=$(python3 - <<\'PY\'',
        'import site; print(site.getusersitepackages())',
        'PY',
        ')',
        '# Visibilidad y carga de librerías',
        'export CUDA_VISIBLE_DEVICES=0',
        'export TF_FORCE_GPU_ALLOW_GROWTH=true',
        // Defaults del modo solicitado (pueden sobreescribirse por ENV)
        `export BATCH_SIZE=\${BATCH_SIZE:-${cfg.BATCH_SIZE}}`,
        `export MIXED_PRECISION=\${MIXED_PRECISION:-${cfg.MIXED_PRECISION}}`,
        'export GPU_WARMUP=${GPU_WARMUP:-0}',
        `export GPU_OPTIMIZED=\${GPU_OPTIMIZED:-${cfg.GPU_OPTIMIZED}}`,
        // Arquitectura por defecto (se puede sobreescribir por ENV)
        `export LSTM_UNITS=\${LSTM_UNITS:-${cfg.LSTM_UNITS}}`,
        `export LSTM_LAYERS=\${LSTM_LAYERS:-${cfg.LSTM_LAYERS}}`,
        `export DENSE_UNITS=\${DENSE_UNITS:-${cfg.DENSE_UNITS}}`,
        `export DROPOUT_RNN=\${DROPOUT_RNN:-${cfg.DROPOUT_RNN}}`,
        `export DROPOUT_DENSE=\${DROPOUT_DENSE:-${cfg.DROPOUT_DENSE}}`,
        `export L2_REG=\${L2_REG:-${cfg.L2_REG || 0.0}}`, // 👈 AÑADIDO: Exportar variable L2
        `export EARLY_STOPPING_PATIENCE=\${EARLY_STOPPING_PATIENCE:-${cfg.EARLY_STOPPING_PATIENCE || 5}}`, // 👈 AÑADIDO: Exportar Paciencia
        `export EARLY_STOPPING_MIN_DELTA=\${EARLY_STOPPING_MIN_DELTA:-${cfg.EARLY_STOPPING_MIN_DELTA || 0.0001}}`, // 👈 AÑADIDO: Exportar Delta
        `export EPOCHS=\${EPOCHS:-${cfg.EPOCHS || 500}}`, // 👈 AÑADIDO: Exportar épocas
        `export DATA_AUGMENTATION=\${DATA_AUGMENTATION:-${cfg.DATA_AUGMENTATION}}`,
        `export REMOVE_DUPLICATES=\${REMOVE_DUPLICATES:-${cfg.REMOVE_DUPLICATES}}`,
        `export AUGMENTATION_FACTOR=\${AUGMENTATION_FACTOR:-${cfg.AUGMENTATION_FACTOR}}`,
        // Configuración de división de datos (Train/Val/Test)
        `export TRAIN_SPLIT=\${TRAIN_SPLIT:-${cfg.TRAIN_SPLIT || 0.6}}`, // 👈 NUEVO: 60% Train por defecto
        `export VAL_SPLIT=\${VAL_SPLIT:-${cfg.VAL_SPLIT || 0.2}}`,       // 👈 NUEVO: 20% Val por defecto
        `export TEST_SPLIT=\${TEST_SPLIT:-${cfg.TEST_SPLIT || 0.2}}`,     // 👈 NUEVO: 20% Test por defecto
        `export GENERATE_NEURAL_DIAGRAM=\${GENERATE_NEURAL_DIAGRAM:-${cfg.GENERATE_NEURAL_DIAGRAM}}`,
        'export LOG_DEVICE_PLACEMENT=${LOG_DEVICE_PLACEMENT:-0}',
        // Conversión TFLite: forzar reconstrucción sin CuDNN para compatibilidad
        'export TFLITE_CONVERT_OFFICIAL=${TFLITE_CONVERT_OFFICIAL:-0}',
        'export TFLITE_SKIP_CUDNN_CONVERT=${TFLITE_SKIP_CUDNN_CONVERT:-1}',
        'export TFLITE_OPTIMIZE=${TFLITE_OPTIMIZE:-0}',
        // Control de apagado global (puede sobreescribirse por ENV)
        `export AUTO_SHUTDOWN=\${AUTO_SHUTDOWN:-${AUTO_SHUTDOWN_ENV}}`,
        // Control de limpieza de CSV (puede sobreescribirse por ENV)
        `export CLEANUP_CSV=\${CLEANUP_CSV:-${CLEANUP_CSV_ENV}}`,
        `export TRAINING_MODE=\${TRAINING_MODE:-${cfg.TRAINING_MODE}}`,
        `export RESTRICTED_LABELS=\${RESTRICTED_LABELS:-'${JSON.stringify(cfg.RESTRICTED_LABELS)}'}`,
        `export CANTIDAD=\${CANTIDAD:-${cfg.CANTIDAD || 0}}`,
        `export TOMATCANTIDA=\${TOMATCANTIDA:-${cfg.TOMATCANTIDA ? '1' : '0'}}`,
        `export MAX_SAMPLES_PER_SIGN=\${MAX_SAMPLES_PER_SIGN:-${cfg.MAX_SAMPLES_PER_SIGN || 0}}`,
        'export LD_LIBRARY_PATH="$VENV_SITE/nvidia/cudnn/lib:$VENV_SITE/nvidia/cublas/lib:$VENV_SITE/nvidia/cuda_runtime/lib:$VENV_SITE/nvidia/cufft/lib:$VENV_SITE/nvidia/curand/lib:$VENV_SITE/nvidia/cusolver/lib:$VENV_SITE/nvidia/cusparse/lib:$VENV_SITE/nvidia/nccl/lib:$VENV_SITE/nvidia/nvjitlink/lib:$LOCAL_SITE/nvidia/cudnn/lib:$LOCAL_SITE/nvidia/cublas/lib:$LOCAL_SITE/nvidia/cuda_runtime/lib:$LOCAL_SITE/nvidia/cufft/lib:$LOCAL_SITE/nvidia/curand/lib:$LOCAL_SITE/nvidia/cusolver/lib:$LOCAL_SITE/nvidia/cusparse/lib:$LOCAL_SITE/nvidia/nccl/lib:$LOCAL_SITE/nvidia/nvjitlink/lib:/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu:/usr/local/cuda-12.2/lib64:/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}"',
        'id',
        'ls -l /dev/nvidia* || true',
        'echo "LD_LIBRARY_PATH=$LD_LIBRARY_PATH"',
        `echo "ENV: BATCH_SIZE=$BATCH_SIZE MIXED_PRECISION=$MIXED_PRECISION GPU_WARMUP=$GPU_WARMUP GPU_OPTIMIZED=$GPU_OPTIMIZED CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES LSTM_LAYERS=\${LSTM_LAYERS:-} LSTM_UNITS=\${LSTM_UNITS:-} DENSE_UNITS=\${DENSE_UNITS:-} DROPOUT_RNN=\${DROPOUT_RNN:-} DROPOUT_DENSE=\${DROPOUT_DENSE:-} L2_REG=\${L2_REG:-} EARLY_STOPPING_PATIENCE=\${EARLY_STOPPING_PATIENCE:-} EARLY_STOPPING_MIN_DELTA=\${EARLY_STOPPING_MIN_DELTA:-} DATA_AUGMENTATION=\${DATA_AUGMENTATION:-} REMOVE_DUPLICATES=\${REMOVE_DUPLICATES:-} AUGMENTATION_FACTOR=\${AUGMENTATION_FACTOR:-} TRAIN_SPLIT=\${TRAIN_SPLIT:-} VAL_SPLIT=\${VAL_SPLIT:-} TEST_SPLIT=\${TEST_SPLIT:-} GENERATE_NEURAL_DIAGRAM=\${GENERATE_NEURAL_DIAGRAM:-} TFLITE_CONVERT_OFFICIAL=$TFLITE_CONVERT_OFFICIAL TFLITE_OPTIMIZE=$TFLITE_OPTIMIZE AUTO_SHUTDOWN=$AUTO_SHUTDOWN CLEANUP_CSV=$CLEANUP_CSV"`,
        'echo "=== DIAG4: NCCL symlink (si falta libnccl.so) ==="',
        'for BASE in "$VENV_SITE/nvidia/nccl/lib" "$LOCAL_SITE/nvidia/nccl/lib"; do',
        '  if [ -d "$BASE" ]; then',
        '    if [ ! -f "$BASE/libnccl.so" ] && [ -f "$BASE/libnccl.so.2" ]; then',
        '      echo "Creando symlink $BASE/libnccl.so -> libnccl.so.2"',
        '      ln -sf "$BASE/libnccl.so.2" "$BASE/libnccl.so" || true',
        '    fi',
        '  fi',
        'done',
        '# Bloque DIAG4 detallado solo si DEBUG=1',
        'if [ "${DEBUG:-0}" = "1" ]; then',
        '  echo "=== DIAG4: Listado de librerías NVIDIA en venv/system ==="',
        '  echo "[venv] $VENV_SITE/nvidia:"',
        '  ls -al "$VENV_SITE/nvidia" || true',
        '  find "$VENV_SITE/nvidia" -maxdepth 2 -type f -name "*.so*" | head -n 100 || true',
        '  echo "[local] $LOCAL_SITE/nvidia:"',
        '  ls -al "$LOCAL_SITE/nvidia" || true',
        '  find "$LOCAL_SITE/nvidia" -maxdepth 2 -type f -name "*.so*" | head -n 100 || true',
        '  echo "=== DIAG4: ctypes.CDLL para libs críticas ==="',
        '$PY_BIN - <<\'PY\'',
        'import ctypes, sys',
        'libs=["libcuda.so.1","libnvidia-ml.so.1","libcudart.so.12","libcublas.so.12","libcudnn.so.9","libcusolver.so.11","libcusparse.so.12","libcurand.so.10","libcufft.so.11","libnvJitLink.so.12","libnccl.so","libnccl.so.2"]',
        'for L in libs:',
        '    try:',
        '        ctypes.CDLL(L)',
        '        print(L, "OK")',
        '    except OSError as e:',
        '        print(L, "ERR:", e)',
        'PY',
        '  echo "=== DIAG4: ldd de _pywrap_tensorflow_internal.so ==="',
        '  TF_SO=$($PY_BIN - <<\'PY\'',
        'import glob, pathlib, tensorflow as tf',
        'import tensorflow.python as tpp',
        'prefix=pathlib.Path(tpp.__file__).parent',
        'cands=sorted(glob.glob(str(prefix/"**/_pywrap_tensorflow_internal*.so"), recursive=True))',
        'print(cands[0] if cands else "")',
        'PY',
        '  )',
        '  if [ -n "$TF_SO" ] && [ -f "$TF_SO" ]; then echo "ldd $TF_SO"; ldd "$TF_SO" || true; else echo "_pywrap_tensorflow_internal.so no encontrado"; fi',
        '  echo "=== DIAG4: ldconfig -p extracto (cuda/cuDNN/cuBLAS/etc.) ==="',
        '  ldconfig -p | egrep -i "cudnn|cublas|cudart|cusolver|cusparse|curand|cufft|nccl|cuda" || true',
        'fi',
        'echo "=== Verificación TF/GPU previa al entrenamiento ==="',
        '$PY_BIN - <<\'PY\'',
        'import tensorflow as tf',
        'print("TF:", tf.__version__)',
        'print("Built with CUDA:", tf.test.is_built_with_cuda())',
        'print("Physical GPUs:", tf.config.list_physical_devices("GPU"))',
        'print("Logical GPUs:", tf.config.list_logical_devices("GPU"))',
        'PY',
        'echo "=== Verificación secundaria con python3 del sistema ==="',
        'python3 - <<\'PY\'',
        'import os, tensorflow as tf',
        'print("sys python:", tf.__version__, os.environ.get("CUDA_VISIBLE_DEVICES"))',
        'print("Physical GPUs:", tf.config.list_physical_devices("GPU"))',
        'print("Logical GPUs:", tf.config.list_logical_devices("GPU"))',
        'PY',
        'echo "=== Ejecutando entrenamiento ==="',
        '# Ejecutar con timeout de 2h y capturar código de salida (incluye 124 por timeout)',
        'EXIT_CODE=0',
        'set +e',
        'timeout 2h $PY_BIN run_training.py',
        'EXIT_CODE=$?',
        'set -e',
        'if [ -n "$VIRTUAL_ENV" ]; then deactivate || true; fi',
        'echo "=== (ubuntu) Finalizado con código: $EXIT_CODE ==="',
        '# Apagar sólo en: éxito (0), timeout (124) o error fatal (cualquier código != 0)',
        'if [ "${AUTO_SHUTDOWN:-1}" = "1" ]; then',
        '  if [ "$EXIT_CODE" -eq 0 ]; then',
        '    echo "[TRAIN] 🔌 Apagando instancia: entrenamiento exitoso (EXIT_CODE=0)";',
        '    sudo shutdown -h now;',
        '  elif [ "$EXIT_CODE" -eq 124 ]; then',
        '    echo "[TRAIN] ⏱️ Timeout de 2 horas alcanzado (EXIT_CODE=124). Apagando instancia";',
        '    sudo shutdown -h now;',
        '  else',
        '    echo "[TRAIN] ❌ Error fatal (EXIT_CODE=$EXIT_CODE). Apagando instancia";',
        '    sudo shutdown -h now;',
        '  fi',
        'fi',
        'exit $EXIT_CODE',
        'EOSUB',
        'chmod +x /tmp/train_as_ubuntu.sh',
        'EXIT_CODE=0',
        '# Ejecutar fuera del cgroup del agente SSM si es posible (systemd-run). Fallback a ejecución directa.',
        'if command -v systemd-run >/dev/null 2>&1; then',
        '  UNIT_NAME="training-job-$(date +%s)"',
        '  echo "Ejecutando con systemd-run como servicio transitorio: $UNIT_NAME"',
        '  # Lanzamos con entorno explícito según modo',
        `  sudo /bin/systemd-run \\
            --unit="$UNIT_NAME" \\
            --description="TensorFlow GPU Training" \\
            --uid=ubuntu \\
            --setenv=CUDA_VISIBLE_DEVICES=0 \\
            --setenv=LD_LIBRARY_PATH="" \\
            --setenv=BATCH_SIZE=${cfg.BATCH_SIZE} \\
            --setenv=MIXED_PRECISION=${cfg.MIXED_PRECISION} \\
            --setenv=GPU_OPTIMIZED=${cfg.GPU_OPTIMIZED} \\
            --setenv=GPU_WARMUP=0 \\
            --setenv=LSTM_LAYERS=${cfg.LSTM_LAYERS} \\
            --setenv=LSTM_UNITS=${cfg.LSTM_UNITS} \\
            --setenv=DENSE_UNITS=${cfg.DENSE_UNITS} \\
            --setenv=DROPOUT_RNN=${cfg.DROPOUT_RNN} \\
            --setenv=DROPOUT_DENSE=${cfg.DROPOUT_DENSE} \\
            --setenv=L2_REG=${cfg.L2_REG || 0.0} \\
            --setenv=EARLY_STOPPING_PATIENCE=${cfg.EARLY_STOPPING_PATIENCE || 5} \\
            --setenv=EARLY_STOPPING_MIN_DELTA=${cfg.EARLY_STOPPING_MIN_DELTA || 0.0001} \\
            --setenv=DATA_AUGMENTATION=${cfg.DATA_AUGMENTATION} \\
            --setenv=REMOVE_DUPLICATES=${cfg.REMOVE_DUPLICATES} \\
            --setenv=AUGMENTATION_FACTOR=${cfg.AUGMENTATION_FACTOR} \\
            --setenv=TFLITE_CONVERT_OFFICIAL=0 \\
            --setenv=TFLITE_SKIP_CUDNN_CONVERT=1 \\
            --setenv=TFLITE_OPTIMIZE=0 \\
            --setenv=AUTO_SHUTDOWN=${AUTO_SHUTDOWN_ENV} \\
            --setenv=CLEANUP_CSV=${CLEANUP_CSV_ENV} \\
            --setenv=TRAINING_MODE=${cfg.TRAINING_MODE} \\
            --setenv=RESTRICTED_LABELS='${JSON.stringify(cfg.RESTRICTED_LABELS)}' \\
            --setenv=CANTIDAD=${cfg.CANTIDAD || 0} \\
            --setenv=TOMATCANTIDA=${cfg.TOMATCANTIDA ? '1' : '0'} \\
            --setenv=MAX_SAMPLES_PER_SIGN=${cfg.MAX_SAMPLES_PER_SIGN || 0} \\
            --setenv=DEBUG=0 \\
        --property=RuntimeMaxSec=7200 \\
        --property=DevicePolicy=closed \\
        --property=DeviceAllow="char-major:195 rwm" \\
        --property=DeviceAllow="char-major:235 rwm" \\
        --property=DeviceAllow="char-major:236 rwm" \\
        --property=DeviceAllow="char-major:241 rwm" \\
        --property=DeviceAllow="/dev/nvidiactl rwm" \\
        --property=DeviceAllow="/dev/nvidia0 rwm" \\
        --property=DeviceAllow="/dev/nvidia-modeset rwm" \\
        --property=DeviceAllow="/dev/nvidia-uvm rwm" \\
        --property=DeviceAllow="/dev/nvidia-uvm-tools rwm" \\
        --property=PrivateDevices=no \\
        /bin/bash -lc "/tmp/train_as_ubuntu.sh" || EXIT_CODE=$? || true`,
        '  echo "Entrenamiento lanzado en background como unidad $UNIT_NAME"',
        '  echo "Logs en: /home/ubuntu/train.log (use: tail -f /home/ubuntu/train.log)"',
        '  echo "Puedes observar GPU con: watch -n1 nvidia-smi"',
        '  echo "Mostrando sólo nuevas líneas del log por 180s para diagnóstico en CloudWatch..."',
        '  # Esperar a que el log aparezca (hasta 30s) y luego hacer tail -n0 -F (solo líneas nuevas)',
        '  sudo -iu ubuntu bash -lc "for i in {1..30}; do [ -f /home/ubuntu/train.log ] && break; sleep 1; done; tail -n0 -F /home/ubuntu/train.log" &',
        '  TAIL_PID=$!',
        '  sleep 180 || true',
        '  kill $TAIL_PID >/dev/null 2>&1 || true',
        '  # No esperamos a que termine; devolvemos control a SSM',
        'else',
        '  echo "systemd-run no disponible. Ejecutando directo (puede heredar cgroup del agente SSM)"',
        '  sudo -iu ubuntu bash -lc "/tmp/train_as_ubuntu.sh" || EXIT_CODE=$? || true',
        'fi',
        'EXIT_CODE=${EXIT_CODE:-0}',
        'echo "=== Finalizado con código: $EXIT_CODE ==="',
        '# Opcional: apagar instancia de forma automática (controlado por env AUTO_SHUTDOWN=1)',
        '# if [ "${AUTO_SHUTDOWN:-0}" = "1" ]; then sudo shutdown -h now; fi'
    ];
    return COMMANDS;
}
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

    // Obtener configuración por defecto
    let cfg = getDefaultConfig();

    // Leer parámetros desde el body (POST)
    try {
        if (event && event.body) {
            const bodyObj = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

            // Fusionar la configuración por defecto con los parámetros recibidos
            if (bodyObj) {
                cfg = {
                    ...cfg,
                    ...bodyObj
                };
            }
        }
    } catch (e) {
        const err = new Error('Body JSON inválido. Debe enviar un objeto con los parámetros de configuración.');
        err.statusCode = 400;
        throw err;
    }

    info(`[TRAINING] Configuración a usar:`, cfg);

    const COMMANDS = buildCommands(cfg);

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
        CommandsLength: COMMANDS.length,
        receivedConfig: cfg
    };
}

module.exports = {
    startTrainingHandler
};