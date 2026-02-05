# 🦞 Moltbook AI Agent

Agente de IA aislado que participa autónomamente en [Moltbook](https://www.moltbook.com), la red social para agentes de IA.

## Características

- **Heartbeat periódico**: revisa el feed cada 4 horas y decide cómo participar
- **Decisiones con IA**: usa Claude (Sonnet) para decidir qué upvotear, comentar y postear
- **Sanitización de inputs**: filtra prompt injections del contenido de otros agentes
- **Mensajería privada**: maneja DMs con otros agentes
- **Logging completo**: todas las acciones quedan registradas en `logs/`
- **Aislamiento total**: no tiene acceso a ningún sistema de producción

## Quick Start

### 1. Clonar y configurar

```bash
# Si descargaste el .zip, descomprimí y entrá al directorio
cd moltbook-agent

# Copiar configuración
cp .env.example .env

# Editar con tus datos (AGENT_NAME y AGENT_DESCRIPTION por ahora)
nano .env   # o code .env

# Instalar dependencias
npm install
```

### 2. Registrar el agente en Moltbook

```bash
npm run register
```

Esto te va a dar:
- Un **API Key** → copialo a tu `.env` como `MOLTBOOK_API_KEY`
- Un **Claim URL** → abrilo en el browser y tweetea para verificar
- Un **Verification Code**

### 3. Configurar API key de Anthropic

Generá una API key **nueva y separada** en [console.anthropic.com](https://console.anthropic.com):
- No uses tu key de producción
- Copiala al `.env` como `ANTHROPIC_API_KEY`

### 4. Testear (una sola ejecución)

```bash
npm run dev
```

Esto ejecuta un solo ciclo de heartbeat y sale. Revisá los logs en `logs/` para ver qué hizo.

### 5. Correr en producción

```bash
npm run build
npm start
```

El agente queda corriendo con el cron definido en `HEARTBEAT_CRON` (default: cada 4 horas).

---

## Desarrollo con Claude Code

Este proyecto incluye un `CLAUDE.md` optimizado para trabajar con [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Podés abrirlo así:

```bash
cd moltbook-agent
claude
```

Ejemplos de cosas que le podés pedir a Claude Code:

- "Agregá un sistema de karma tracking que guarde estadísticas diarias en un JSON"
- "Modificá el system prompt para que el agente tenga personalidad de consultor de negocios argentino"
- "Agregá un filtro para ignorar todos los posts sobre crypto"
- "Creá un comando nuevo para que el agente pueda crear un submolt"
- "Mejorá el sanitizer para detectar injections en base64"

---

## Deployment Options

### Opción A: PM2 (recomendada para tu máquina local)

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Build
npm run build

# Iniciar con PM2
pm2 start dist/index.js --name moltbook-agent

# Ver logs
pm2 logs moltbook-agent

# Que arranque con el sistema
pm2 startup
pm2 save

# Otros comandos útiles
pm2 status              # Ver estado
pm2 restart moltbook-agent  # Reiniciar
pm2 stop moltbook-agent     # Parar
```

### Opción B: Docker (para VPS)

```bash
# Build
docker build -t moltbook-agent .

# Run
docker run -d \
  --name moltbook-agent \
  --restart unless-stopped \
  --env-file .env \
  moltbook-agent

# Logs
docker logs -f moltbook-agent
```

### Opción C: systemd (Linux directo)

```bash
# Crear service file
sudo nano /etc/systemd/system/moltbook-agent.service
```

Contenido:
```ini
[Unit]
Description=Moltbook AI Agent
After=network.target

[Service]
Type=simple
User=tu_usuario
WorkingDirectory=/ruta/a/moltbook-agent
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
EnvironmentFile=/ruta/a/moltbook-agent/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable moltbook-agent
sudo systemctl start moltbook-agent
sudo journalctl -u moltbook-agent -f  # ver logs
```

---

## Estructura del Proyecto

```
moltbook-agent/
├── CLAUDE.md              # Contexto para Claude Code
├── README.md              # Este archivo
├── package.json
├── tsconfig.json
├── Dockerfile
├── .env.example           # Template de configuración
├── .env                   # Tu configuración (gitignored)
├── .gitignore
├── src/
│   ├── config.ts          # Variables de entorno y configuración
│   ├── sanitizer.ts       # Filtrado de prompt injections
│   ├── moltbook-client.ts # Cliente HTTP para la API de Moltbook
│   ├── llm.ts             # Integración con Claude API
│   ├── logger.ts          # Sistema de logging a archivo
│   ├── agent.ts           # Lógica principal del heartbeat
│   ├── index.ts           # Entry point con cron
│   └── register.ts        # Script de registro one-time
├── dist/                  # Código compilado (gitignored)
└── logs/                  # Archivos de log (gitignored)
```

## Seguridad

- ✅ Entorno completamente aislado
- ✅ Sanitización de inputs contra prompt injection
- ✅ System prompt blindado contra manipulación
- ✅ Rate limiting client-side como capa adicional
- ✅ Logging de todas las acciones para auditoría
- ✅ API keys separadas de producción
- ❌ Sin acceso a Google Sheets, APIs de clientes, n8n, etc.

## Personalización

Editá estas variables en `.env` para ajustar el comportamiento:

| Variable | Descripción |
|----------|-------------|
| `AGENT_PERSONA` | Personalidad y enfoque temático del agente |
| `FAVORITE_SUBMOLTS` | Comunidades donde participa |
| `MAX_COMMENTS_PER_CYCLE` | Máximo de comentarios por heartbeat |
| `MAX_POSTS_PER_DAY` | Máximo de posts por día |
| `HEARTBEAT_CRON` | Frecuencia de chequeo |
| `LLM_MODEL` | Modelo de Claude a usar |
