import express from "express";
import cors from "cors";
import sql from "mssql";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import OpenAI from "openai";

dotenv.config();

// --- Configurar el cliente de IA ---
const iaClient = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL,
});

const app = express();

// --- CORS configurado para Ionic y Azure ---
// La URL de Azure App Service es el dominio de la aplicación. 
// Para CORS, se necesita la URL de *donde proviene la petición* (tu app cliente), no el dominio de la API.
// Asumiendo que "api-tickets-daym.azurewebsites.net" es la URL de tu *API*, la remuevo de allowedOrigins 
// y dejo solo el frontend de Ionic si fuese necesario, o ajusta esta lista a tus clientes.
const allowedOrigins = [
    "http://localhost:8100", // Ionic local
    // Añade el dominio de tu aplicación Ionic/móvil si está desplegada en otro lugar.
];

app.use(
    cors({
        origin: function (origin, callback) {
            // Permitir peticiones sin origen (como clientes REST o llamadas internas)
            if (!origin) return callback(null, true);
            
            // Permitir el origen si está en la lista blanca
            if (allowedOrigins.includes(origin)) return callback(null, true);

            // **IMPORTANTE para Azure:** Permitir el dominio de Azure App Service y el subdominio si se usa.
            // Esto permite que el backend pueda ser accedido directamente por otras APIs o servicios en Azure.
            if (origin.endsWith('.azurewebsites.net')) return callback(null, true);

            console.warn("CORS bloqueado para origen:", origin);
            return callback(new Error("CORS no permitido"));
        },
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
    })
);

app.use(express.json());

// --- Configuración de la base de datos ---
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: {
        encrypt: true,
        // En Azure, a menudo es preferible usar 'true' para la conexión a SQL Server en Azure.
        // Si tu DB no es Azure SQL, 'false' podría ser correcto, pero si lo es, cámbialo a 'true' y asegúrate de que 'encrypt' también sea 'true'.
        trustServerCertificate: false, 
    },
    connectionTimeout: 30000,
    requestTimeout: 30000,
};

// --- Función de IA para clasificar prioridad ---
async function clasificarPrioridadIA(descripcion) {
    const RECHAZO_NO_TECNICO = "Entrada inválida";

    try {
        const completion = await iaClient.chat.completions.create({
            model: "deepseek/deepseek-chat-v3.1:free",
            messages: [
                {
                    role: "system",
                    content: `Tu única función es clasificar la prioridad de una incidencia técnica. 
Si la entrada del usuario es un problema técnico (relacionado con software, hardware, redes o infraestructura), 
responde SOLAMENTE con una de estas tres palabras: Baja, Media o Alta. 
Si la entrada NO es técnica, responde exactamente con: ${RECHAZO_NO_TECNICO}.`,
                },
                {
                    role: "user",
                    content: `Problema: ${descripcion}`,
                },
            ],
            temperature: 0.0,
            max_tokens: 10,
        });

        let respuesta = completion.choices[0].message.content
            .trim()
            .replace(/[<>\[\]{}|\\/_.,;:!¡¿?'"`*~^%$#@-]/g, "")
            .replace(/\s+/g, "")
            .toLowerCase();

        if (respuesta.includes("alta")) respuesta = "Alta";
        else if (respuesta.includes("media")) respuesta = "Media";
        else if (respuesta.includes("baja")) respuesta = "Baja";
        else if (respuesta.includes(RECHAZO_NO_TECNICO.toLowerCase())) respuesta = "Baja";
        else respuesta = "Baja";

        return respuesta;
    } catch (err) {
        console.error("Error al clasificar con IA:", err.message);
        return "Baja";
    }
}

// --- Endpoint raíz ---
app.get("/", (req, res) => {
    res.send("API móvil de Tickets corriendo correctamente en Azure App Service 🚀");
});

// --- Login ---
app.post("/movil/login", async (req, res) => {
    const { usuario, contrasena } = req.body;

    if (!usuario || !contrasena) {
        return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool
            .request()
            .input("usuario", sql.VarChar, usuario)
            .query("SELECT * FROM tbl_usuarios WHERE usuario = @usuario AND activo = 1");

        const user = result.recordset[0];
        if (!user) {
            return res.status(404).json({ error: "Usuario no encontrado o inactivo" });
        }

        let passwordValido = false;
        if (user.password.startsWith("$2b$") || user.password.startsWith("$2a$")) {
            passwordValido = await bcrypt.compare(contrasena, user.password);
        } else {
            passwordValido = contrasena === user.password;
        }

        if (!passwordValido) {
            return res.status(401).json({ error: "Contraseña incorrecta" });
        }

        res.json({
            mensaje: "Login exitoso",
            usuario: {
                id: user.id_usuario,
                nombre: user.nombre,
                apellido: user.apellido,
                usuario: user.usuario,
                correo: user.correo,
                rol: user.id_rol,
                area: user.id_area,
            },
        });
    } catch (err) {
        console.error("Error en login:", err);
        res.status(500).json({ error: "Error en el servidor" });
    }
});

// --- Tickets por usuario ---
app.get("/movil/tickets/usuario/:idUsuario", async (req, res) => {
    const { idUsuario } = req.params;

    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool
            .request()
            .input("idUsuario", sql.Int, idUsuario)
            .query(`
                SELECT 
                    id_ticket AS id,
                    titulo,
                    descripcion_problema AS descripcion,
                    estado,
                    prioridad,
                    fecha_creacion
                FROM tbl_tickets
                WHERE id_usuario = @idUsuario
                ORDER BY fecha_creacion DESC
            `);

        res.json(result.recordset);
    } catch (err) {
        console.error("Error al obtener tickets del usuario:", err);
        res.status(500).json({ error: "Error al obtener tickets" });
    }
});

// --- Crear ticket ---
app.post("/movil/tickets", async (req, res) => {
    const { id_usuario, id_area, titulo, descripcion_problema } = req.body;

    if (!id_usuario || !id_area || !titulo || !descripcion_problema) {
        return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    try {
        let prioridadIA = await clasificarPrioridadIA(descripcion_problema);
        console.log(`Prioridad sugerida por IA: ${prioridadIA}`);

        const prioridadesValidas = ["Alta", "Media", "Baja"];
        if (!prioridadesValidas.includes(prioridadIA)) prioridadIA = "Baja";

        const pool = await sql.connect(dbConfig);
        await pool
            .request()
            .input("id_usuario", sql.Int, id_usuario)
            .input("id_area", sql.Int, id_area)
            .input("titulo", sql.VarChar, titulo)
            .input("descripcion_problema", sql.VarChar, descripcion_problema)
            .input("prioridad", sql.VarChar, prioridadIA)
            .query(`
                INSERT INTO tbl_tickets (id_usuario, id_area, titulo, descripcion_problema, prioridad, estado)
                VALUES (@id_usuario, @id_area, @titulo, @descripcion_problema, @prioridad, 'En proceso')
            `);

        res.json({
            mensaje: "Ticket creado correctamente",
            prioridad_asignada: prioridadIA,
        });
    } catch (err) {
        console.error("Error al crear ticket:", err);
        res.status(500).json({ error: "Error al crear el ticket" });
    }
});

// --- Test conexión DB ---
app.get("/movil/test-db", async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request().query("SELECT GETDATE() AS fecha");
        res.json({
            conexion: "exitosa",
            fecha_servidor: result.recordset[0].fecha,
        });
    } catch (err) {
        console.error("Error de conexión:", err);
        res.status(500).json({
            error: "No se pudo conectar a la base de datos",
            detalle: err.message,
        });
    }
});

// **MODIFICACIÓN CLAVE PARA AZURE APP SERVICES**
// Azure inyecta el puerto en la variable de entorno PORT.
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
    // Opcional: Para logs de Azure (se envía a stdout, lo que Azure registra)
    console.log(`Node.js Express server listening on port ${PORT}`);
});