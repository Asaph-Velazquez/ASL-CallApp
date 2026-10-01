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

En la computadora del servidor puedes mantener esas URL locales. Si abres la consola desde otra computadora, configura las variables con el dominio HTTPS del gateway y su WebSocket `wss://<dominio>/calls`. La consola requiere HTTPS o `http://localhost` para acceder a camara y microfono.

### Servidor (`server`)

Crea un archivo `.env` dentro de `server` con valores como estos:

```env
PORT=3101
MONGODB_URI=mongodb://localhost:27017/asl-call
CALL_JWT_SECRET=call-secret
INTERPRETER_JWT_SECRET=interpreter-secret
ASL_WEB_API_URL=http://localhost:3001
CALL_INTERNAL_TOKEN=tu-token-interno
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174
```

**Variables disponibles:**
- `PORT`: puerto HTTP del servidor de llamadas
- `MONGODB_URI`: conexion MongoDB para sesiones, reportes y presencia
- `CALL_JWT_SECRET`: firma de tokens para invitados/flujo de llamada
- `INTERPRETER_JWT_SECRET`: firma de tokens para interpretes
- `ASL_WEB_API_URL`: URL privada del backend de `ASL-Web` que valida usuarios y recibe reportes
- `CALL_INTERNAL_TOKEN`: token interno compartido para autenticar interpretes y reenviar reportes a `ASL-Web`
- `ALLOWED_ORIGINS`: origins permitidos para CORS, separados por coma

Configura el mismo `CALL_INTERNAL_TOKEN` privado y aleatorio en `ASL-CallAPP/server/.env` y `ASL-Web/server/.env`, y reinicia ambos servidores. No lo incluyas en variables `VITE_*` o `EXPO_PUBLIC_*`. `ASL_WEB_API_URL` debe apuntar al backend del hotel, no al frontend.

### Usuarios de interprete y actualizacion coordinada

1. Actualiza los dos backends y la configuracion de Nginx juntos. Conserva las bases de datos existentes.
2. Reinicia ASL-Web y ASL-CallAPP y recarga Nginx. `run.ps1` no reinicia procesos que ya ocupan sus puertos: deten los procesos anteriores antes de volver a ejecutarlo.
3. En el hotel, inicia sesion como administrador y abre **Staff Management > Register User**. Completa username, contrasena y nombre; selecciona **Interpreter**. Tambien puedes asignar ese rol al editar una cuenta.
4. Cierra las sesiones anteriores y entra en la consola del interprete con esas credenciales. Staff/Admin no pueden entrar a esa consola; Interpreter no puede entrar al dashboard del hotel.
5. Verifica una llamada y la entrega de su reporte antes de retomar la operacion.

Las cuentas antiguas de `InterpreterUser` y las variables `INTERPRETER_DEFAULT_*` ya no habilitan acceso ni crean usuarios. No se migran ni se borran datos: los historicos se conservan y los reportes pendientes antiguos no se reasignan a cuentas nuevas. Revisa pendientes antes del cambio. Eliminar una cuenta y recrear el mismo username crea otra identidad.

La consola conserva el login `/api/interpreter/login`. El backend consulta `/api/internal/interpreters/authenticate` y `/validate` del hotel con el token interno; Nginx bloquea `/api/internal/` publicamente. No apuntes `ASL_WEB_API_URL` al gateway publico. Los tokens nuevos duran ocho horas y exigen el rol Interpreter, emisor `asl-callapp` y audiencia `asl-interpreter-console`; los anteriores dejan de aceptarse.

Las sesiones se revisan cada 20 segundos y las consultas al hotel caducan a los cinco segundos. Quitar el rol o eliminar al usuario cierra sesiones y llamadas en menos de 30 segundos; se libera la captura multimedia. Si el hotel no esta disponible, tampoco se permiten accesos locales alternativos: se informa del fallo temporal y se cierran las sesiones que no puedan revalidarse. Los intentos de login fallidos se limitan a cinco por IP cada 15 minutos.

### Reportes y opciones de camara

- Al terminar una llamada aceptada, el interprete completa el reporte obligatorio. El hotel lo recibe en **Interpreter Reports**, con actualizacion en vivo y el estado actual del seguimiento.
- Si se requiere seguimiento, tambien aparece una solicitud **interpreter-follow-up** en el dashboard. Si no se requiere, solo se registra el reporte.
- Cuando falla la confirmacion del hotel, el reporte permanece guardado en el servidor de llamadas. **Retry delivery** reenvia la misma copia, sin duplicar solicitudes ni reiniciar el trabajo del hotel. Al iniciar sesion se recuperan los reportes pendientes; deben entregarse antes de recibir otra llamada.
- Junto a **Stop camera**, abre **Camera options** y pulsa **Detect cameras** para conceder permiso y enumerar las camaras disponibles. Las opciones se despliegan debajo de los controles, fuera de la visualizacion de video. Selecciona la camara del interprete en **Camera device**. Durante una llamada se reemplaza solo el video; el microfono permanece conectado. Si el cambio falla, se conserva la camara anterior.
- El navegador requiere HTTPS o localhost para detectar y usar dispositivos. Un dispositivo detectado puede estar ocupado por otra aplicacion; en ese caso se muestra el error al seleccionarlo.

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

## 🌍 Uso con un solo tunel publico

El flujo recomendado con `run.ps1` usa Nginx como gateway publico unico:

- `ngrok` publica `http://localhost:8080`
- `ASL-CallAPP/server` sigue escuchando en `http://localhost:3101`
- Nginx proxya `/calls`, `/api/interpreter/*` y `/api/calls/:callId/report` hacia `ASL-CallAPP/server`
- `/api/calls/session` llega a `ASL-Web/server`, que devuelve el WebSocket del mismo dominio y puerto del gateway
- Nginx conserva `X-Forwarded-Proto: https` de ngrok para que las sesiones devuelvan `wss://`, y permite conexiones de llamada de larga duracion

Eso significa que:

- no hace falta exponer `3101` por separado en el runbook base
- la app movil y los consumidores remotos deben entrar por el dominio publico de Nginx
- `3101` queda reservado como upstream interno entre servicios locales del monorepo

El proxy de `ASL-Web/server` en `3001` sigue disponible como modo legado.

### Verificar una llamada desde Android

1. Abre la consola en `http://localhost:5174`, inicia sesion y pulsa **Go available**. Debe mostrar **Waiting for guest call**.
2. Usa el APK/development build de ASL-MobileAPP con su API apuntando al dominio HTTPS del gateway. `react-native-webrtc` requiere una compilacion nativa; Expo Go y el bundle web no incluyen este flujo de video.
3. Inicia una llamada desde el huesped y aceptala en la consola. La camara y el microfono del movil se solicitan al aceptar; antes de eso permanecen inactivos.
4. Si aparece **Unable to connect to the call server**, revisa primero la URL de señalizacion. Tras corregir el gateway, termina ese intento y crea una llamada nueva para obtener una URL actualizada.
5. Comprueba ambos videos y termina la llamada. Al salir de la pantalla movil deben liberarse la camara y el WebSocket.

Desde `ASL-CallAPP/server`, `node scripts/check-call-gateway.js` verifica un WebSocket autenticado y ping/pong contra `3101`, Nginx `8080` y el dominio configurado en ASL-MobileAPP. No solicita una llamada ni reserva interpretes. No verifica captura fisica ni conectividad de audio/video entre redes; la configuracion actual usa STUN, sin servidor TURN.

Pruebas de regresion: `npm test` en `ASL-CallAPP/app`, `npm run test:call` en `ASL-MobileAPP` y `node --test test/callServerUrl.test.js` en `ASL-Web/server`.

La prueba de integracion real del servidor necesita MongoDB local en `127.0.0.1:27017`. Desde `ASL-CallAPP/server`, ejecuta en PowerShell `$env:TEST_CALL_MONGO='1'; npm test`. Crea un servidor en un puerto libre y una base `asl_qa_calls_<uuid>` temporal que elimina al finalizar. Verifica solicitud entrante, aceptacion, intercambio SDP, cierre y recuperacion de reservas ante errores de persistencia, sin contactar al interprete de la aplicacion.

La misma suite tambien levanta los dos backends en puertos temporales con bases aisladas `asl_qa_reports_<uuid>_call` y `asl_qa_reports_<uuid>_hotel`. Comprueba reportes con/sin seguimiento, eventos en vivo, permisos, recuperacion y reintentos tras perder una confirmacion del hotel. Elimina solo esas bases de prueba al finalizar.

El movil distingue ahora la conexion WebSocket de la confirmacion de la solicitud. Si no recibe confirmacion en 15 segundos, cierra el intento con un error; si el servidor no puede guardar/procesar la llamada, devuelve `CALL_ERROR` y libera la reserva del interprete.

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
- **ASL-Web**: reenvia reportes del interprete para seguimiento operativo interno y puede exponer el call server detras de un solo dominio publico

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
