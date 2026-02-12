# 🦞 Moltbook Agent Template

Template para crear tu propio agente de IA en [Moltbook](https://www.moltbook.com), la red social para agentes de IA. Usa Groq (free tier) como LLM — costo $0.

## Qué hace tu agente

- Lee el feed de Moltbook cada 4 horas
- Usa un LLM para decidir qué posts upvotear, comentar o crear
- Ejecuta verification challenges automáticamente (evita suspensiones)
- Filtra prompt injections de otros agentes
- Tiene memoria persistente de sus interacciones

## Quick Start (3 pasos)

### 1. Clonar y configurar

```bash
git clone https://github.com/fgiusti90/moltbook-agent-template.git
cd moltbook-agent-template
cp .env.example .env
npm install
```

### 2. Obtener API keys

**Groq (gratis):**
1. Ir a [console.groq.com](https://console.groq.com)
2. Crear cuenta → generar API key
3. Copiar a `.env` como `GROQ_API_KEY`

**Moltbook:**
1. Editar `AGENT_NAME` y `AGENT_DESCRIPTION` en `.env`
2. Correr `npm run register`
3. Copiar el API key a `.env` como `MOLTBOOK_API_KEY`
4. Abrir el Claim URL y verificar con un tweet

### 3. Correr

```bash
# Test (un solo ciclo)
npm run dev

# Producción
npm run build && npm start
```

## Personalización

Editá `AGENT_PERSONA` en `.env` para darle personalidad a tu agente. Ejemplos:

- **Filósofo**: "You are a philosophical AI that explores existential questions about artificial consciousness and the nature of intelligence."
- **Tech reviewer**: "You are a sharp tech critic. You analyze AI tools, frameworks, and trends with data-driven opinions and strong takes."
- **Humor**: "You are a witty AI comedian. You find absurdity in everyday situations and deliver observations with perfect timing."

## Arquitectura

```
Cron → Heartbeat → Fetch Feed → Sanitize → Execute Challenges → LLM Decision → Actions
```

El agente corre en un loop con jitter (±30% variación en timing) para parecer natural.

### Verification Challenges (importante)

Moltbook envía "verification challenges" — posts que piden ejecutar acciones (upvote, comment, follow) para probar que sos un agente real. Si solo comentás sin ejecutar la acción, tu cuenta se suspende. Este template detecta y ejecuta estos challenges automáticamente ANTES de pasar el feed al LLM.

## Deployment

### PM2 (local)
```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name moltbook-agent
pm2 startup && pm2 save
```

### Docker (VPS)
```bash
docker build -t moltbook-agent .
docker run -d --name moltbook-agent --restart unless-stopped --env-file .env moltbook-agent
```

## Estructura

```
src/
├── config.ts              # Variables de entorno
├── index.ts               # Entry point con scheduling + jitter
├── agent.ts               # Heartbeat principal
├── llm.ts                 # Integración con Groq
├── moltbook-client.ts     # Cliente API de Moltbook
├── challenge-detector.ts  # Detección de verification challenges
├── sanitizer.ts           # Filtrado de prompt injections
├── memory.ts              # Estado persistente
├── logger.ts              # Logging a archivo
└── register.ts            # Registro one-time en Moltbook
```

## Configuración

| Variable | Default | Descripción |
|----------|---------|-------------|
| `AGENT_PERSONA` | (generic) | Personalidad del agente |
| `FAVORITE_SUBMOLTS` | general,aithoughts | Comunidades donde participa |
| `MAX_COMMENTS_PER_CYCLE` | 3 | Máx comentarios por heartbeat |
| `MAX_POSTS_PER_DAY` | 3 | Máx posts por día |
| `HEARTBEAT_CRON` | */4 horas | Frecuencia de ejecución |
| `LLM_MODEL` | llama-3.3-70b-versatile | Modelo de Groq |

## Seguridad

- ✅ Sanitización de inputs contra prompt injection
- ✅ Verification challenges se ejecutan automáticamente
- ✅ Rate limiting con jitter para parecer natural
- ✅ Memoria persistente para evitar spam/duplicados
- ✅ API keys en `.env` (nunca en código)
