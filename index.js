import express from "express";
import cors from "cors";
import sql from "mssql";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import OpenAI from "openai";

dotenv.config();

// --- Configurar cliente IA (OpenRouter) ---
const iaClient = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL,
    defaultHeaders: {
        "HTTP-Referer": "https://api-tickets-production-1357.up.railway.app", // dominio de tu backend
        "X-Title": "Sistema de Tickets", // nombre de tu app
    },
});

// --- Express ---
const app = express();

// --- CORS ---
const allowedOrigins = [
    "http://localhost:8100", // Ionic local
];
app.use(
    cors({
        origin: function (origin, callback) {
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) return callback(null, true);
            if (origin.endsWith(".azurewebsites.net")) return callback(null, true);
            console.warn("CORS bloqueado para origen:", origin);
            return callback(new Error("CORS no permitido"));
        },
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
    })
);
app.use(express.json());

// --- Configuración DB ---
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: {
        encrypt: true,
        trustServerCertificate: false,
    },
    connectionTimeout: 30000,
    requestTimeout: 30000,
};

// --- Clasificación IA ---
async function clasificarPrioridadIA(descripcion) {
    const RECHAZO_NO_TECNICO = "Entrada inválida";

    try {
        // Llamada al modelo gratuito de OpenRouter
        const completion = await iaClient.chat.completions.create({
            model: "openai/gpt-oss-20b:free",
            messages: [
                {
                    role: "system",
                    content: `Eres un asistente que clasifica incidencias técnicas.
Responde con una sola palabra: Alta, Media o Baja. 
Si el texto no describe un problema técnico, responde "${RECHAZO_NO_TECNICO}".`,
                },
                {
                    role: "user",
                    content: `Problema: ${descripcion}`,
                },
            ],
            temperature: 0,
            max_tokens: 10,
            extra_body: { reasoning: { enabled: true } }, // modo reasoning opcional
        });

        const respuesta = completion.choices[0].message.content.trim().toLowerCase();

        if (respuesta.includes("alta")) return "Alta";
        if (respuesta.includes("media")) return "Media";
        if (respuesta.includes("baja")) return "Baja";

        return "Baja";
    } catch (err) {
        console.error("Error al clasificar con IA:", err.response?.data || err.message);
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
        if (!user) return res.status(404).json({ error: "Usuario no encontrado o inactivo" });

        let passwordValido = false;
        if (user.password.startsWith("$2b$") || user.password.startsWith("$2a$")) {
            passwordValido = await bcrypt.compare(contrasena, user.password);
        } else {
            passwordValido = contrasena === user.password;
        }

        if (!passwordValido) return res.status(401).json({ error: "Contraseña incorrecta" });

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

//tickets de tecnico

app.get("/movil/tickets/tecnico/:idTecnico", async (req, res) => {
    const { idTecnico } = req.params;

    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool
            .request()
            .input("idTecnico", sql.Int, idTecnico)
            .query(`
                SELECT 
                    t.id_ticket AS id,
                    t.titulo,
                    t.descripcion_problema AS descripcion,
                    t.estado,
                    t.prioridad,
                    t.fecha_creacion,
                    u.id_usuario AS id_usuario,
                    u.nombre AS nombre_usuario,
                    u.apellido AS apellido_usuario,
                    a.nombre_area AS area_usuario
                FROM tbl_tickets t
                INNER JOIN tbl_usuarios u ON t.id_usuario = u.id_usuario
                LEFT JOIN tbl_areas a ON u.id_area = a.id_area
                WHERE t.id_tecnico = @idTecnico
                ORDER BY t.fecha_creacion DESC
            `);

        res.json(result.recordset);
    } catch (err) {
        console.error("Error al obtener tickets del técnico:", err);
        res.status(500).json({ error: "Error al obtener tickets del técnico" });
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

// --- Cambiar estado del ticket (solo técnicos) ---
app.put("/movil/tickets/:idTicket/estado", async (req, res) => {
    const { idTicket } = req.params;
    const { nuevoEstado } = req.body;

    const estadosValidos = ["En proceso", "Cerrado", "Cancelado"];
    if (!estadosValidos.includes(nuevoEstado)) {
        return res.status(400).json({ error: "Estado inválido" });
    }

    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool
            .request()
            .input("idTicket", sql.Int, idTicket)
            .input("estado", sql.VarChar, nuevoEstado)
            .query(`
                UPDATE tbl_tickets
                SET estado = @estado,
                    fecha_cierre = CASE WHEN @estado = 'Cerrado' THEN GETDATE() ELSE NULL END
                WHERE id_ticket = @idTicket
            `);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ error: "Ticket no encontrado" });
        }

        res.json({ mensaje: `Ticket actualizado a estado: ${nuevoEstado}` });
    } catch (err) {
        console.error("Error al actualizar estado del ticket:", err);
        res.status(500).json({ error: "Error al actualizar el estado del ticket" });
    }
});

// --- Actualizar username y contraseña ---
app.put("/movil/usuario/:idUsuario", async (req, res) => {
    const { idUsuario } = req.params;
    const { nuevoUsuario, nuevaContrasena } = req.body;

    if (!nuevoUsuario && !nuevaContrasena) {
        return res.status(400).json({ error: "Debe enviar al menos un campo para actualizar" });
    }

    try {
        const pool = await sql.connect(dbConfig);

        // Si se va a cambiar la contraseña, la encriptamos
        let hashedPassword = null;
        if (nuevaContrasena) {
            const salt = await bcrypt.genSalt(10);
            hashedPassword = await bcrypt.hash(nuevaContrasena, salt);
        }

        // Construir dinámicamente la consulta
        let query = "UPDATE tbl_usuarios SET ";
        if (nuevoUsuario) query += "usuario = @nuevoUsuario";
        if (nuevaContrasena) query += (nuevoUsuario ? ", " : "") + "password = @nuevaContrasena";
        query += " WHERE id_usuario = @idUsuario";

        const result = await pool
            .request()
            .input("idUsuario", sql.Int, idUsuario)
            .input("nuevoUsuario", sql.VarChar, nuevoUsuario || null)
            .input("nuevaContrasena", sql.VarChar, hashedPassword || null)
            .query(query);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        res.json({ mensaje: "Usuario actualizado correctamente" });
    } catch (err) {
        console.error("Error al actualizar usuario:", err);
        res.status(500).json({ error: "Error al actualizar los datos del usuario" });
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





// --- Registrar evaluación de un ticket cerrado ---
app.post("/movil/evaluaciones", async (req, res) => {
    const { id_ticket, id_usuario, calificacion, comentario } = req.body;

    if (!id_ticket || !id_usuario || !calificacion) {
        return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    try {
        const pool = await sql.connect(dbConfig);

        // Verificar que el ticket pertenece al usuario y esté cerrado
        const ticket = await pool.request()
            .input("id_ticket", sql.Int, id_ticket)
            .input("id_usuario", sql.Int, id_usuario)
            .query(`
                SELECT estado FROM tbl_tickets
                WHERE id_ticket = @id_ticket AND id_usuario = @id_usuario
            `);

        if (ticket.recordset.length === 0)
            return res.status(404).json({ error: "Ticket no encontrado o no pertenece al usuario" });

        if (ticket.recordset[0].estado !== "Cerrado")
            return res.status(400).json({ error: "Solo se pueden evaluar tickets cerrados" });

        // Insertar evaluación
        await pool.request()
            .input("id_ticket", sql.Int, id_ticket)
            .input("id_usuario", sql.Int, id_usuario)
            .input("rol_evaluador", sql.VarChar, "Usuario")
            .input("calificacion", sql.Int, calificacion)
            .input("comentario", sql.VarChar, comentario || null)
            .query(`
                INSERT INTO tbl_evaluaciones (id_ticket, id_usuario, rol_evaluador, calificacion, comentario)
                VALUES (@id_ticket, @id_usuario, @rol_evaluador, @calificacion, @comentario)
            `);

        res.json({ mensaje: "Evaluación registrada correctamente" });
    } catch (err) {
        console.error("Error al registrar evaluación:", err);
        res.status(500).json({ error: "Error al registrar la evaluación" });
    }
});



// --- Verificar si un ticket ya fue evaluado por el usuario ---
app.get("/movil/evaluaciones/verificar/:idTicket/:idUsuario", async (req, res) => {
    const { idTicket, idUsuario } = req.params;
    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool
            .request()
            .input("idTicket", sql.Int, idTicket)
            .input("idUsuario", sql.Int, idUsuario)
            .query(`
                SELECT COUNT(*) AS total
                FROM tbl_evaluaciones
                WHERE id_ticket = @idTicket AND id_usuario = @idUsuario AND rol_evaluador = 'Usuario'
            `);

        const evaluado = result.recordset[0].total > 0;
        res.json({ evaluado });
    } catch (err) {
        console.error("Error al verificar evaluación:", err);
        res.status(500).json({ evaluado: false });
    }
});










// --- Servidor ---
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
