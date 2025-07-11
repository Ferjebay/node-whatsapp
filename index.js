const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const { exec } = require('child_process');
const log = (pino = require("pino"));
const path = require('path');
const { Boom } = require("@hapi/boom");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = require("express")();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
const server = require("http").createServer(app);
const io = require("socket.io")(server, {
  cors: { origin: '*' }
});
const port = process.env.PORT || 8000;
const qrcode = require("qrcode");

let sock = null;
let socket_client;
let qrDinamic;
let reiniciarPorNuevaSesion = false;
let sessiones = {};

cron.schedule('3 0 * * *', () => {
  console.log('🕛 REINICIANDO DESDE CRON A LAS 12:03 AM...');
  reiniciarServidor();

  exec("pm2 flush 131", (error, stdout, stderr) => {
    if (error) {
      console.error(`Error al ejecutar el comando: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Error en la salida estándar: ${stderr}`);
      return;
    }
    console.log(`Resultado del comando:\n${stdout}`);
  });

});

const reiniciarServidor = () => {
  console.log('REINICIANDO...')
  exec("pm2 restart 131", (error, stdout, stderr) => {
    if (error) {
      console.error(`Error al ejecutar el comando: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Error en la salida estándar: ${stderr}`);
      return;
    }
    console.log(`Resultado del comando:\n${stdout}`);
  });
}

const renombrarCarpeta = (nombre) => {
  fs.rename('./sessiones/test', nombre, (err) => {
    if (err) {
      console.error('Error al cambiar el nombre de la carpeta:', err);
    } else {
      console.log('El nombre de la carpeta ha sido cambiado con éxito.');
    }
  });
}

const cargarSessiones = async () => {

  const content = await fs.readFileSync('./telefono.txt', 'utf8');

  if ( content.trim().length > 0 ) {
    eliminarCarpetaDirectorio(`./sessiones/${ content }`);
    escribirArchivo('');
  }

  fs.readdir('./sessiones', async (err, archivos) => {
    if (err) {
      console.error('Error al leer la carpeta:', err);
      return;
    }

    const carpetas = archivos.filter(nombreArchivo => {
      return fs.statSync(`./sessiones/${nombreArchivo}`).isDirectory();
    });

    let time = 0
    for (let index = 0; index < carpetas.length; index++) {
      const element = carpetas[index];

      console.log('cargar-sessiones', element)

      const contenido = await fs.readdirSync(`./sessiones/${ element }`);

      if ( contenido.length === 0 ) {
        fs.rmdirSync(`./sessiones/${ element }`, { recursive: true });
      } else {
        setTimeout(() => {
          connectToWhatsApp( element, true )
          .then(res => { console.log("sessiones cargadas", res) })
          .catch(err => { console.log( "problema iuston",  err ) })
        }, time)
      }

      time += 4000;
    }
  });

  const reconectando = {};

  setInterval(() => {
    console.log("⏱ Verificando sesiones activas...");

    Object.keys(sessiones).forEach(movil => {
      const sesion = sessiones[movil];
      const sock = sesion?.socket;
      const ws = sock?.ws?.socket;

      if (sock && ws && ws.readyState === 1) {
        console.log(`✅ [${movil}] sesión activa`);
        return;
      }

      if (reconectando[movil]) {
        console.log(`⚠️ [${movil}] reconexión ya en curso...`);
        return;
      }

      console.log(`🔄 [${movil}] sesión caída detectada, intentando reconectar...`);
      reconectando[movil] = true;

      connectToWhatsApp(movil)
        .then(() => console.log(`✅ [${movil}] reconectado correctamente`))
        .catch(err => console.error(`❌ [${movil}] Error al reconectar:`, err))
        .finally(() => { reconectando[movil] = false; });
    });
  }, 5 * 60 * 1000);

  setInterval(() => {
    console.log("💓 Enviando presencia...");
    Object.entries(sessiones).forEach(async ([movil, { socket }]) => {
      try {
        await socket.sendPresenceUpdate('available');
        console.log(`📡 Presencia enviada a [${movil}]`);
      } catch (err) {
        console.error(`❌ [${movil}] Error al enviar presencia:`, err.message);
      }
    });
  }, 2 * 60 * 1000);

}

function eliminarCarpetaDirectorio(ruta) {
  if (fs.existsSync(ruta)) {
      fs.readdirSync(ruta).forEach(function (archivo, indice) {
          const archivoRuta = path.join(ruta, archivo);
          if (fs.lstatSync(archivoRuta).isDirectory()) {
              eliminarCarpetaDirectorio(archivoRuta);
          } else {
              fs.unlinkSync(archivoRuta);
          }
      });
      fs.rmdirSync(ruta);
      console.log(`Carpeta ${ruta} eliminada correctamente.`);
  } else {
      console.log(`La carpeta ${ruta} no existe.`);
  }
}

function escribirArchivo(content) {
  fs.writeFile('./telefono.txt', `${content}`, function(err) {
    if(err)
      console.error('Error al escribir en el archivo:', err);
    else
      console.log('Número guardado en el archivo correctamente.');
  });
}

async function connectToWhatsApp( movil, nuevaSesion = false ) {
  let session2, estado, saveCreds2;

  if ( movil !== null && movil !== "" ) {
    const { session } = { session: movil.toString() };
    session2 = session;

    carpetaAEliminar = `./sessiones/${ movil.toString() }`;

    let { state, saveCreds } = await useMultiFileAuthState(`./sessiones/${movil.toString()}`);

    estado = state;
    saveCreds2 = saveCreds;
  } else {
    let { state, saveCreds } = await useMultiFileAuthState("./sessiones/test");
    estado = state;
    saveCreds2 = saveCreds;
  }

  let config = {
    printQRInTerminal: true,
    auth: estado,
    keepAliveIntervalMs: 60000,
    logger: log({ level: "silent" })
  }

  if ( movil !== null && movil !== "" ) config.auth = estado

  sock = makeWASocket( config );

  sock.ev.on("creds.update", saveCreds2);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    qrDinamic = qr;

    try {
      if (connection === "close") {
        let reason = new Boom(lastDisconnect.error).output.statusCode;
        if (reason === DisconnectReason.badSession) {
          console.log(`Bad Session File, Please Delete ${session2} and Scan Again`);
          sock.logout();
        } else if (reason === DisconnectReason.connectionClosed) {
          console.log("Conexión cerrada, reconectando....");
          connectToWhatsApp(movil);
        } else if (reason === DisconnectReason.connectionLost) {
          console.log("Conexión perdida del servidor, reconectando...");
          connectToWhatsApp(movil);
        } else if (reason === DisconnectReason.connectionReplaced) {
          console.log("Conexión reemplazada, otra nueva sesión abierta, cierre la sesión actual primero");
          // sock.logout();

          reiniciarServidor()

          // delete sessiones[movil];
          // await connectToWhatsApp(movil);
          return;
        } else if (reason === DisconnectReason.loggedOut) {
          if (!reiniciarPorNuevaSesion)
            escribirArchivo(session2);

          reiniciarServidor()
        } else if (reason === DisconnectReason.restartRequired) {
          console.log("Se requiere reinicio, reiniciando...");
          connectToWhatsApp(movil);
        } else if (reason === DisconnectReason.timedOut) {
          console.log("Se agotó el tiempo de conexión, conectando...");
          connectToWhatsApp(movil);
        } else {
          sock.end(`Motivo de desconexión desconocido: ${reason}|${lastDisconnect.error}`);
        }
      } else if (connection === "open") {

        const { id } = sock?.user;

        console.log(`OJO ${ id } -- ${ id.split(':')[0] }`);

        if ( !existeCarpeta(`./sessiones/${ id.split(':')[0] }`) || nuevaSesion) {

          const carpetaExiste = existeCarpeta('./sessiones/test');

          if ( carpetaExiste ) {
            renombrarCarpeta(`./sessiones/${id.split(':')[0]}`)
          }

          sessiones[`${id.split(':')[0]}`] = {
            socket: sock
          };

          updateQR("connected", `${id.split(':')[0]}`);

          setTimeout(() => {
            if (reiniciarPorNuevaSesion)
              reiniciarServidor();
          }, 1500)
        } else {
          console.log("CONTRARIO");

          updateQR("connected", `${id.split(':')[0]}`);

          // setTimeout(() => {
          //   reiniciarServidor();
          // }, 1500)
        }

        return;
      }
    } catch (error) {
      console.log("MAL: ", error);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      // if (type === "notify") {
      //   if (!messages[0]?.key.fromMe) {
      //     const captureMessage = messages[0]?.message?.conversation;
      //     const numberWa = messages[0]?.key?.remoteJid;

      //     const compareMessage = captureMessage.toLocaleLowerCase();

      //     if (compareMessage === "ping") {
      //       await sock.sendMessage(
      //         numberWa,
      //         {
      //           text: "Pong",
      //         },
      //         {
      //           quoted: messages[0],
      //         }
      //       );
      //     } else {
      //       await sock.sendMessage(
      //         numberWa,
      //         {
      //           text: "Soy un robot",
      //         },
      //         {
      //           quoted: messages[0],
      //         }
      //       );
      //     }
      //   }
      // }
    } catch (error) {
      console.log("error ", error);
    }
  });
}

const isConnected = ( movil ) => {
  return sessiones[`${ movil }`] ? true : false;
};

const existeCarpeta = (rutaCarpeta) => {
  try {
    fs.accessSync(rutaCarpeta);
    return true;
  } catch (err) {
    return false;
  }
}

io.on("connection", async (socket) => {
  socket_client = socket;
});

const transformarRuta = (ruta, dominio, tipo) => {
  let rutaModificada = ruta.replace(/\\/g, "/");

  let indiceInicio = '';

  if (tipo == 'pdf') {
    indiceInicio = rutaModificada.indexOf("PDF/") + "PDF/".length;
  } else {
    indiceInicio = rutaModificada.indexOf("static/SRI/") + "static/SRI/".length;
  }

  let parteRelevante = rutaModificada.slice(indiceInicio);

  let nuevaRuta = `${dominio}/sri/${ tipo === 'pdf' ? 'PDF/' : '' }${parteRelevante}`;

  return nuevaRuta;
}

const estadoSesionActiva = (movil) => {
  const sesion = sessiones[movil];

  if (!sesion || !sesion.socket) return false;

  const sock = sesion.socket;
  const webSocket = sock?.ws?.socket;

  return !!(sock?.user && webSocket?.readyState === 1);
};

app.post("/estado-sesion", async (req, res) => {
  const { movil } = req.body;

  if (!movil) {
    return res.status(400).json({ error: "Número inválido" });
  }

  const activo = estadoSesionActiva(movil);
  return res.status(200).json({ movil, conectado: activo });
});

app.post("/send-comprobantes", async (req, res) => {
  let {
    telefono,
    urlPDF,
    urlXML,
    number,
    cliente,
    num_comprobante,
    empresa,
    dominio,
    isp
  } = req.body;

  try {

    if (isp) {
      urlPDF = transformarRuta( urlPDF, dominio, 'pdf' )
      urlXML = transformarRuta( urlXML, dominio, 'xml' )
    }

    const carpetaExiste = existeCarpeta(`./sessiones/${ telefono }`);

    let numberWA = number + "@s.whatsapp.net";

    if (carpetaExiste) {

      const exist = await sessiones[telefono].socket.onWhatsApp(numberWA);

      if (exist?.jid || (exist && exist[0]?.jid)) {

        try {
          await sessiones[telefono].socket.sendMessage(exist.jid || exist[0].jid, {
            text: `*Estimado(a):* ${ cliente } la empresa *${ empresa }* le ha emitido la siguiente factura a su nombre: \n\nFactura: ${ num_comprobante }\n\nA continuacion adjuntamos el comprobante electrónico en formato XML y PDF.`
          });

          await sessiones[telefono].socket.sendMessage(exist.jid || exist[0].jid, {
            document: { url: urlXML },
            fileName: `${ num_comprobante }.xml`,
            Mimetype: "application/xml"
          })

          await sessiones[telefono].socket.sendMessage(exist.jid || exist[0].jid, {
            document: { url: urlPDF },
            fileName: `${ num_comprobante }.pdf`,
            Mimetype: "application/pdf"
          });

          res.status(200).json({ status: true });

        } catch (error) {
          res.status(500).send("error ws");
        }
      }
    } else {
      res.status(500).send("error ws");
    }
  } catch (err) {
    console.log(err);
    res.status(500).send("error ws");
  }
});

app.post("/send-message", async (req, res) => {
  let {
    numero_sesion,
    client_number,
    cliente,
    msg
  } = req.body;

  try {

    const carpetaExiste = existeCarpeta(`./sessiones/${ numero_sesion }`);

    let numberWA = client_number + "@s.whatsapp.net";

    if (carpetaExiste) {

      const exist = await sessiones[numero_sesion].socket.onWhatsApp(numberWA);

      if (exist?.jid || (exist && exist[0]?.jid)) {

        try {
          await sessiones[numero_sesion].socket.sendMessage(exist.jid || exist[0].jid, {
            text: msg
          });

          res.status(200).json({ status: true });

        } catch (error) {
          res.status(500).send("error ws");
        }
      } else {
        res.status(200).json({ status: true, msg: 'no tiene whatsApp' });
      }
    } else {
      res.status(500).send("error ws");
    }
  } catch (err) {
    console.log(err)
    // axios.post('https://hooks.slack.com/services/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', {
    //   "text": `
    //     Error en api whatsApp *** ${cliente} - ${ client_number } *** ${new Date().toLocaleTimeString('es-ES', {
    //       hour: '2-digit',
    //       minute: '2-digit',
    //       hour12: true
    //     })} - ${new Date().toLocaleDateString('es-ES')} -
    //     ${err.message}
    //   `
    // });
    res.status(500).send("error ws");
  }
});

app.post("/send-message-file", async (req, res) => {

  let {
    client_number,
    numero_sesion,
    nameFile,
    urlPDF
  } = req.body;

  try {
    const carpetaExiste = existeCarpeta(`./sessiones/${ numero_sesion }`);

    let numberWA = client_number + "@s.whatsapp.net";

    if (carpetaExiste) {

      const exist = await sessiones[numero_sesion].socket.onWhatsApp(numberWA);

      if (exist?.jid || (exist && exist[0]?.jid)) {

        try {
           await sessiones[numero_sesion].socket.sendMessage(exist.jid || exist[0].jid, {
            document: { url: urlPDF },
            fileName: nameFile,
            Mimetype: "application/pdf"
          });

          res.status(200).json({ status: true });

        } catch (error) {
          console.log(error)
          res.status(500).send("error ws");
        }
      }
    } else {
      res.status(500).send("error ws");
    }
  } catch (err) {
    console.log(err)
    // axios.post('https://hooks.slack.com/services/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', {
    //   "text": `
    //     Error en api whatsApp *** ${cliente} - ${ client_number } *** ${new Date().toLocaleTimeString('es-ES', {
    //       hour: '2-digit',
    //       minute: '2-digit',
    //       hour12: true
    //     })} - ${new Date().toLocaleDateString('es-ES')} -
    //     ${err.message}
    //   `
    // });
    res.status(500).send("error ws");
  }
});

app.post("/send-comprobantes-proforma", async (req, res) => {
  const {
    urlPDF,
    number,
    telefono,
    cliente,
    empresa,
    name_proforma
  } = req.body;

  try {
      const carpetaExiste = existeCarpeta(`./sessiones/${ telefono }`);

      let numberWA = number + "@s.whatsapp.net";

      if (carpetaExiste) {
        const exist = await sessiones[telefono].socket.onWhatsApp(numberWA);

        if (exist?.jid || (exist && exist[0]?.jid)) {

          try {
            await sessiones[telefono].socket.sendMessage(exist.jid || exist[0].jid, {
              text: `*Estimado(a):* ${ cliente } la empresa *${ empresa }* le ha emitido la siguiente proforma a su nombre`
            });

            await sessiones[telefono].socket.sendMessage(exist.jid || exist[0].jid, {
              document: { url: urlPDF },
              fileName: name_proforma,
              Mimetype: "application/pdf"
            });

            res.status(200).json({ status: true });

          } catch (error) {
            res.status(500).send("error ws");
          }
        }
      } else {
        res.status(500).send("error ws");
      }
  } catch (err) {
    res.status(500).send("error ws");
  }
});

app.get("/", async (req, res) => {
  res.status(200).send('OK');
});

app.post("/check-state", async (req, res) => {
  let { movil } = req.body;

  if (isConnected( movil )) {
    setTimeout(() => {
      updateQR("connected", movil);
    }, 1000)
  } else {

    const carpetaExiste = existeCarpeta(`./sessiones/${ movil }`);

    if ( movil?.length > 0 && !carpetaExiste ) movil = null

    reiniciarPorNuevaSesion = true;
    await connectToWhatsApp(movil);

    setTimeout(async () => {
      updateQR("qr");
    }, 2500);
  }
  res.status(200).send('OK');
})

const updateQR = (data, movil = '') => {
  try {
    switch (data) {
      case "qr":
        qrcode.toDataURL(qrDinamic, (err, url) => {
          socket_client?.emit("qr", { qr: url, tipo: 'qr' });
        });
        break;
      case "connected":
        const { id, name } = sessiones[`${ movil }`].socket.user;
        var userinfo = id + " " + name;

        socket_client?.emit("conectado", {
          qrstatus: "/imgs/check.svg",
          user: userinfo,
          tipo: "connected"
        });

        break;
      case "loading":
        res.json({
          qrstatus: "./assets/loader.gif",
          user: userinfo,
          tipo: "loading"
        });
        break;
      default:
        break;
    }
  } catch (error) {
    console.log("error", error);
  }
};

cargarSessiones();

// connectToWhatsApp().catch((err) => console.log("unexpected error: " + err));

server.listen(port, () => {
  console.log("Server Run Port : " + port);
});
