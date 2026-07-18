# 📞 ASL CallAPP

Dominio de llamadas del sistema ASL para conectar huespedes con interpretes en tiempo real, registrar presencia operativa y reenviar reportes de seguimiento hacia `ASL-Web`.

## 📋 Caracteristicas

### Servidor de Llamadas
- API HTTP para autenticacion de interpretes y actualizacion de presencia
- Servidor WebSocket para senalizacion de llamadas entre huesped e interprete
- Registro de sesiones de llamada en MongoDB
- Finalizacion de llamadas por cierre normal, rechazo o error de red

### Consola del Interprete
- Login de interprete con token JWT
- Cambio de disponibilidad para recibir llamadas
- Recepcion y aceptacion/rechazo de llamadas entrantes
- Captura de reporte obligatorio al finalizar una llamada

### Integracion con ASL-Web
- Reenvio de reportes de interpretacion al panel web
- Generacion de seguimiento cuando la llamada requiere acciones adicionales
- Sincronizacion del contexto operativo entre llamada y panel administrativo

## 🚀 Comenzar

### Instalacion

#### Frontend del interprete

```bash
cd app
npm install
cd ..
```

#### Servidor de llamadas

```bash
cd server
npm install
cd ..
```

## ⚙️ Configurar Variables de Entorno

### Frontend (`app`)

1. Entra a la carpeta del frontend:

```bash
cd app
```

2. Crea tu archivo local a partir del ejemplo:

```bash
cp .env.example .env
```

3. Variables disponibles:

```env
VITE_CALL_API_URL=http://localhost:3101
VITE_CALL_WS_URL=ws://localhost:3101/calls
```

- `VITE_CALL_API_URL`: URL base del backend de `ASL-CallApp`
- `VITE_CALL_WS_URL`: endpoint WebSocket para la sesion de llamada

### Servidor (`server`)

Crea un archivo `.env` dentro de `server` con valores como estos:

```env
PORT=3101
MONGODB_URI=mongodb://localhost:27017/asl-call
CALL_JWT_SECRET=call-secret
INTERPRETER_JWT_SECRET=interpreter-secret
ASL_WEB_API_URL=http://localhost:3001
CALL_INTERNAL_TOKEN=tu-token-interno
INTERPRETER_DEFAULT_USERNAME=interpreter
INTERPRETER_DEFAULT_PASSWORD=hotel2026
INTERPRETER_DEFAULT_FULL_NAME=Hotel Interpreter
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174
```

**Variables disponibles:**
- `PORT`: puerto HTTP del servidor de llamadas
- `MONGODB_URI`: conexion MongoDB para sesiones, reportes y presencia
- `CALL_JWT_SECRET`: firma de tokens para invitados/flujo de llamada
- `INTERPRETER_JWT_SECRET`: firma de tokens para interpretes
- `ASL_WEB_API_URL`: URL del backend de `ASL-Web` que recibe reportes
- `CALL_INTERNAL_TOKEN`: token interno usado para reenviar reportes a `ASL-Web`
- `INTERPRETER_DEFAULT_*`: credenciales iniciales del interprete por defecto
- `ALLOWED_ORIGINS`: origins permitidos para CORS, separados por coma

## ▶️ Ejecutar el Proyecto

Asegurate de que MongoDB este disponible antes de iniciar el servidor.

**Terminal 1 - Servidor de llamadas:**

```bash
cd server
npm run dev
```

O en modo normal:

```bash
npm start
```

El servidor quedara disponible en `http://localhost:3101` y el WebSocket en `ws://localhost:3101/calls`.

**Terminal 2 - Consola del interprete:**

```bash
cd app
npm run dev
```

La consola web correra en `http://localhost:5173` o el puerto asignado por Vite.

## 🛠️ Tecnologias

- **Frontend**: React 19
- **Build Tool**: Vite
- **Backend**: Node.js + Express
- **WebSocket**: `ws`
- **Base de Datos**: MongoDB + Mongoose
- **Autenticacion**: JWT

## 📁 Estructura del Proyecto

```text
ASL-CallApp/
├── app/                         # Consola web del interprete
│   ├── src/
│   │   ├── App.tsx             # Flujo principal del interprete
│   │   ├── main.tsx            # Punto de entrada
│   │   ├── index.css           # Estilos globales
│   │   └── vite-env.d.ts
│   ├── .env.example            # Variables del frontend
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── server/                      # API + WebSocket + persistencia
│   ├── index.js                # Servidor principal y senalizacion
│   ├── models/
│   │   ├── CallSession.js      # Sesiones de llamada
│   │   ├── InterpreterPresence.js
│   │   ├── InterpreterReport.js
│   │   ├── InterpreterUser.js
│   │   └── index.js
│   ├── package.json
│   └── package-lock.json
└── README.md
```

## 🧪 Scripts Disponibles

### `app`

```bash
npm run dev        # Iniciar frontend en desarrollo
npm run build      # Compilar frontend para produccion
npm run preview    # Previsualizar build del frontend
```

### `server`

```bash
npm run dev        # Iniciar backend con watch
npm start          # Iniciar backend en modo normal
```

## 🔗 Integracion

`ASL-CallApp` se comunica con:

- **ASL-MobileAPP**: participa en el flujo de llamada iniciado desde la experiencia del huesped
- **ASL-Web**: reenvia reportes del interprete para seguimiento operativo interno

### Flujo de Comunicacion

1. El huesped inicia una solicitud de llamada.
2. `ASL-CallApp/server` localiza un interprete disponible.
3. La consola `ASL-CallApp/app` recibe y gestiona la llamada en tiempo real.
4. Al finalizar, el interprete captura un reporte.
5. El backend reenvia ese reporte a `ASL-Web` para seguimiento si aplica.

## 🏗️ Arquitectura

```text
┌─────────────────┐          ┌────────────────────┐          ┌──────────────────┐
│   HUESPED/APP   │◄────────►│ ASL-CallApp/server │◄────────►│ ASL-CallApp/app  │
│  Flujo de llamada│  WS/HTTP │ Express + ws + DB  │   JWT    │ Consola interprete│
└─────────────────┘          └────────────────────┘          └──────────────────┘
                                       │
                                       │ HTTP interno
                                       ▼
                               ┌──────────────────┐
                               │     ASL-Web      │
                               │ Seguimiento staff│
                               └──────────────────┘
```

## 📝 Desarrollo

El proyecto utiliza:
- **React + Vite** para la interfaz del interprete
- **Express + ws** para la senalizacion de llamadas
- **MongoDB + Mongoose** para persistencia operativa
- **JWT** para autenticacion de interpretes y sesiones
- **Fetch interno** para reenvio de reportes hacia `ASL-Web`
