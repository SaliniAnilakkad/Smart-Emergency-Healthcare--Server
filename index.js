require('dotenv').config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const admin = require("firebase-admin");
const fs = require("fs");
const winston = require("winston");

console.log("Starting server...");

// Setup Winston logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: "server.log" }),
    new winston.transports.Console(),
  ],
});

// Validate Chrome executable path from .env
const chromePath = process.env.CHROME_PATH;
if (!chromePath || !fs.existsSync(chromePath)) {
  logger.error(`Chrome executable not found at: ${chromePath}. Please verify the path or install Chrome.`);
  process.exit(1);
}

// Firebase initialization using path from .env
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
if (!serviceAccountPath || !fs.existsSync(serviceAccountPath)) {
  logger.error(`Firebase service account key not found at: ${serviceAccountPath}. Please provide a valid path in .env.`);
  process.exit(1);
}
const serviceAccount = require(serviceAccountPath);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// Define hospital name
const hospitalName = "MediCare";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: "http://localhost:5173",
  credentials: true,
}));
app.use(express.json());

// WhatsApp setup
let client = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./.wwebjs_auth",
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--remote-debugging-port=0",
      "--disable-dev-tools",
      "--disable-extensions",
    ],
    executablePath: chromePath,
    timeout: 180000, // Increased timeout to 180 seconds
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    dumpio: true, // Enable debug output for Puppeteer
  },
});

let currentQr = null;
let currentStatus = "loading";
let isClientReady = false; // Track client readiness
let unsubscribeBookingListener = null; // To manage Firestore listener

async function deleteSessionFolder() {
  const sessionDir = "./.wwebjs_auth";
  if (!fs.existsSync(sessionDir)) {
    logger.info("No session folder found, skipping deletion.");
    return;
  }
  const maxRetries = 5;
  const retryDelay = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
      logger.info("Successfully deleted .wwebjs_auth folder.");
      return;
    } catch (err) {
      logger.error(`Attempt ${attempt} to delete .wwebjs_auth failed: ${err.message}`);
      if (attempt === maxRetries) {
        throw new Error(`Failed to delete session folder after ${maxRetries} attempts: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

// Function to validate WhatsApp session
async function validateSession() {
  return new Promise((resolve) => {
    client.getState().then(state => {
      logger.info(`Session state: ${state}`);
      if (state === "CONNECTED") {
        // Additional validation: Try to get contacts
        client.getContacts().then(contacts => {
          logger.info(`Contact retrieval successful, count: ${contacts.length}`);
          resolve(true);
        }).catch(err => {
          logger.error(`Contact retrieval failed: ${err.message}`);
          resolve(false);
        });
      } else {
        resolve(false);
      }
    }).catch(err => {
      logger.error(`Session validation error: ${err.message}`);
      resolve(false);
    });
  });
}

async function sendWhatsAppMessage(phone, message, maxRetries = 3) {
  const phoneRegex = /^\+\d{10,12}$/;
  if (!phoneRegex.test(phone)) {
    logger.error(`Invalid phone number format: ${phone}`);
    throw new Error("Invalid phone number format");
  }

  const whatsappId = phone.replace("+", "") + "@c.us";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (!isClientReady) {
        logger.warn("Client not ready, delaying message send");
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      const isValidSession = await validateSession();
      if (!isValidSession) {
        logger.error("Session not valid, skipping message send");
        throw new Error("Invalid session state");
      }

      logger.info(`Attempting to send message to ${phone}, Session Info: ${JSON.stringify(await client.getState())}`);

      // Check if chat exists and initialize if necessary
      const chats = await client.getChats();
      const chat = chats.find(c => c.id._serialized === whatsappId);
      if (!chat) {
        logger.warn(`Chat not found for ${phone}, creating new chat`);
        await client.getChatById(whatsappId); // Force chat creation
      }

      const response = await client.sendMessage(whatsappId, message);
      logger.info(`Message sent successfully to ${phone}: ${JSON.stringify(response)}`);
      return;
    } catch (err) {
      logger.error(`Attempt ${attempt} failed to send message to ${phone}: ${err.stack}`, { message });
      if (attempt === maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Endpoint to reset WhatsApp session
app.post("/api/reset-whatsapp", async (req, res) => {
  logger.info("Resetting WhatsApp session...");
  currentStatus = "loading";
  io.emit("status", currentStatus);

  try {
    if (client && client.pupBrowser) {
      await client.destroy(); // Close browser and clean up
    }
    await deleteSessionFolder(); // Delete session data
    currentQr = null; // Clear old QR
    client = new Client({
      authStrategy: new LocalAuth({
        dataPath: "./.wwebjs_auth",
      }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-zygote",
          "--remote-debugging-port=0",
          "--disable-dev-tools",
          "--disable-extensions",
        ],
        executablePath: chromePath,
        timeout: 180000, // Increased timeout to 180 seconds
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        dumpio: true, // Enable debug output for Puppeteer
      },
    });

    // Attach event listeners
    client.on("qr", (qr) => {
      logger.info("QR event triggered at: " + new Date().toISOString());
      qrcode.toDataURL(qr, (err, qrImageUrl) => {
        if (err) {
          logger.error("QR Generation Error: " + err.message);
          currentStatus = "Error generating QR code";
          io.emit("status", currentStatus);
          return;
        }
        logger.info("QR code generated successfully at: " + new Date().toISOString());
        currentQr = qrImageUrl;
        currentStatus = "Not authenticated - Please scan QR code";
        io.emit("qr", qrImageUrl);
        io.emit("status", currentStatus);
      });
    });

    client.on("ready", () => {
      logger.info("WhatsApp client ready");
      currentStatus = "Authenticated";
      isClientReady = true; // Mark client as ready
      io.emit("status", currentStatus);
      startBookingListener(); // Start listener only after client is ready
    });

    client.on("authenticated", () => {
      logger.info("WhatsApp session authenticated");
      currentStatus = "Authenticated";
      io.emit("status", currentStatus);
    });

    client.on("auth_failure", (msg) => {
      logger.error("Authentication failure: " + JSON.stringify(msg));
      currentStatus = "Not authenticated - Authentication failed";
      io.emit("status", currentStatus);
      client.initialize().catch((err) => logger.error("Reinitialization error: " + err.message));
    });

    client.on("disconnected", async (reason) => {
      logger.info("WhatsApp disconnected: " + reason);
      currentStatus = "Not authenticated - Disconnected";
      isClientReady = false; // Mark client as not ready
      io.emit("status", currentStatus);
      try {
        await client.destroy();
        await deleteSessionFolder();
        setTimeout(() => {
          logger.info("Reinitializing WhatsApp client...");
          client.initialize().catch((err) => logger.error("Client reinitialization error: " + err.message));
        }, 10000); // Increased to 10 seconds
      } catch (err) {
        logger.error("Error handling disconnection: " + err.message);
      }
    });

    await client.initialize();
    res.json({ message: "WhatsApp session reset successfully. Please scan the new QR code." });
  } catch (err) {
    logger.error("Error resetting WhatsApp session: " + err.message);
    currentStatus = `Error: ${err.message}`;
    io.emit("status", currentStatus);
    res.status(500).json({ error: err.message || "Failed to reset WhatsApp session." });
  }
});

// New endpoint to test WhatsApp message sending
app.post("/api/test-whatsapp", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: "Phone and message are required" });
  }

  try {
    await sendWhatsAppMessage(phone, message);
    res.json({ success: true, message: "Test message sent successfully" });
  } catch (err) {
    logger.error(`Test message failed: ${err.message}`, { phone, message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// Function to start Firestore listener
function startBookingListener() {
  // Unsubscribe any existing listener
  if (unsubscribeBookingListener) {
    unsubscribeBookingListener();
    logger.info("Unsubscribed from previous booking listener");
  }

  unsubscribeBookingListener = db.collection("bookings")
    .where("processed", "==", false) // Only process unprocessed bookings
    .onSnapshot(
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added") {
            const bookingData = change.doc.data();
            const patientId = bookingData.patientId;
            const doctorId = bookingData.doctorId;

            if (!patientId || !doctorId) {
              logger.error(`Invalid booking data: Missing patientId or doctorId`, { bookingData });
              return;
            }

            // Query patients collection where uid matches patientId
            db.collection("patients")
              .where("uid", "==", patientId)
              .get()
              .then((querySnapshot) => {
                if (querySnapshot.empty) {
                  logger.error(`No patient document found for uid: ${patientId}`, { bookingData });
                  return;
                }
                const patientDoc = querySnapshot.docs[0].data();
                const patientPhone = patientDoc.phone || "";
                if (!patientPhone) {
                  logger.error(`Patient phone number missing for uid: ${patientId}`, { patientDoc });
                  return;
                }

                // Format timeslot as a string
                let appointmentTime = "Not specified";
                let date = "Not specified";
                let time = "Not specified";
                if (bookingData.timeslot) {
                  if (bookingData.timeslot.toDate) {
                    const timeslotDate = bookingData.timeslot.toDate();
                    appointmentTime = timeslotDate.toLocaleString();
                    date = timeslotDate.toLocaleDateString('en-GB'); // e.g., 20/04/2025
                    time = timeslotDate.toLocaleTimeString('en-GB', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: true
                    }).replace(/^0/, ''); // Remove leading zero for 12-hour format (e.g., 00:50 -> 12:50)
                  } else {
                    appointmentTime = bookingData.timeslot.toString();
                  }
                }

                db.collection("doctors")
                  .doc(doctorId)
                  .get()
                  .then((doctorDoc) => {
                    if (!doctorDoc.exists) {
                      logger.error(`Doctor document not found for ID: ${doctorId}`, { bookingData });
                      return;
                    }
                    const doctor = doctorDoc.data();
                    const doctorName = doctor.name || "Unknown Doctor";

                    const message = `*Appointment Confirmation*\n\n*Hello ${patientDoc.name || "Patient"},*\n\nWe are pleased to inform you that your appointment at ${hospitalName} has been confirmed.\n👨‍⚕ *Doctor*: ${doctorName}\n📅 *Date*: ${date}\n⏰ *Time*: ${time}\n\nThank you for choosing us! 😊\n*${hospitalName} Team*`;

                    // Send message only if client is ready
                    if (isClientReady) {
                      sendWhatsAppMessage(patientPhone, message)
                        .then(() => {
                          // Mark as processed after successful send
                          return change.doc.ref.update({ processed: true });
                        })
                        .catch((err) => {
                          logger.error(`Failed to send message after retries to ${patientPhone}: ${err.stack}`, { message });
                          if (err.message.includes("invalid wid")) {
                            logger.warn("Persistent invalid wid error, reinitializing client...");
                            isClientReady = false;
                            client.initialize().catch((err) => logger.error("Reinitialization error: " + err.message));
                          }
                        });
                    } else {
                      logger.error("Client not ready to send message", { patientPhone, message });
                    }
                  })
                  .catch((err) => {
                    logger.error(`Error fetching doctor data for ID: ${doctorId}: ${err.message}`, { bookingData });
                  });
              })
              .catch((err) => {
                logger.error(`Error querying patient data for uid: ${patientId}: ${err.message}`, { bookingData });
              });
          }
        });
      },
      (error) => {
        logger.error(`Firestore snapshot error: ${error.message}`);
      }
    );
}

// Reminder message scheduler
function scheduleReminderCheck() {
  const checkReminders = async () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0); // Start of tomorrow

    const tomorrowEnd = new Date(tomorrow);
    tomorrowEnd.setDate(tomorrow.getDate() + 1); // End of tomorrow

    const snapshot = await db.collection("bookings")
      .where("timeslot", ">=", tomorrow)
      .where("timeslot", "<", tomorrowEnd)
      .where("reminded", "==", false)
      .get();

    for (const doc of snapshot.docs) {
      const bookingData = doc.data();
      const patientId = bookingData.patientId;
      const doctorId = bookingData.doctorId;

      if (!patientId || !doctorId) {
        logger.error(`Invalid booking data for reminder: Missing patientId or doctorId`, { bookingData });
        continue;
      }

      db.collection("patients")
        .where("uid", "==", patientId)
        .get()
        .then((querySnapshot) => {
          if (querySnapshot.empty) {
            logger.error(`No patient document found for uid: ${patientId}`, { bookingData });
            return;
          }
          const patientDoc = querySnapshot.docs[0].data();
          const patientPhone = patientDoc.phone || "";
          if (!patientPhone) {
            logger.error(`Patient phone number missing for uid: ${patientId}`, { patientDoc });
            return;
          }

          let date = tomorrow.toLocaleDateString('en-GB');
          let time = "";
          if (bookingData.timeslot && bookingData.timeslot.toDate) {
            time = bookingData.timeslot.toDate().toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true
            }).replace(/^0/, ''); // Remove leading zero for 12-hour format (e.g., 00:50 -> 12:50)
          }

          db.collection("doctors")
            .doc(doctorId)
            .get()
            .then((doctorDoc) => {
              if (!doctorDoc.exists) {
                logger.error(`Doctor document not found for ID: ${doctorId}`, { bookingData });
                return;
              }
              const doctor = doctorDoc.data();
              const doctorName = doctor.name || "Unknown Doctor";

              const message = `*Reminder: Upcoming Appointment*\n\n*Hello ${patientDoc.name || "Patient"},*\n\nThis is a gentle reminder about your appointment scheduled for tomorrow at ${hospitalName}.\n👨‍⚕ *Doctor:* ${doctorName}\n📅 *Date:* ${date}\n⏰ *Time:* ${time}\n\nIf you're unable to attend, you can cancel your appointment anytime by logging into our website.\n\nThank you for choosing us! 😊\n*${hospitalName} Team*`;
              if (isClientReady) {
                sendWhatsAppMessage(patientPhone, message)
                  .then(() => {
                    return doc.ref.update({ reminded: true });
                  })
                  .catch((err) => {
                    logger.error(`Failed to send reminder to ${patientPhone}: ${err.stack}`, { message });
                    if (err.message.includes("invalid wid")) {
                      isClientReady = false;
                      client.initialize().catch((err) => logger.error("Reinitialization error: " + err.message));
                    }
                  });
              } else {
                logger.error("Client not ready to send reminder", { patientPhone, message });
              }
            })
            .catch((err) => {
              logger.error(`Error fetching doctor data for ID: ${doctorId}: ${err.message}`, { bookingData });
            });
        })
        .catch((err) => {
          logger.error(`Error querying patient data for uid: ${patientId}: ${err.message}`, { bookingData });
        });
    }
  };

  // Schedule check at 6 PM daily
  const now = new Date();
  const targetTime = new Date(now);
  targetTime.setHours(17, 0, 0, 0); // 6 PM today
  if (now > targetTime) targetTime.setDate(targetTime.getDate() + 1); // If past 6 PM, set to tomorrow

  const timeUntil6PM = targetTime - now;
  setTimeout(() => {
    checkReminders();
    setInterval(checkReminders, 24 * 60 * 60 * 1000); // Run daily
  }, timeUntil6PM);
}
// Initial event listeners
client.on("qr", (qr) => {
  logger.info("QR event triggered at: " + new Date().toISOString());
  qrcode.toDataURL(qr, (err, qrImageUrl) => {
    if (err) {
      logger.error("QR Generation Error: " + err.message);
      currentStatus = "Error generating QR code";
      io.emit("status", currentStatus);
      return;
    }
    logger.info("QR code generated successfully at: " + new Date().toISOString());
    currentQr = qrImageUrl;
    currentStatus = "Not authenticated - Please scan QR code";
    io.emit("qr", qrImageUrl);
    io.emit("status", currentStatus);
  });
});

client.on("ready", () => {
  logger.info("Client is ready - WhatsApp session established");
  currentStatus = "Authenticated";
  isClientReady = true;
  io.emit("status", currentStatus);
  startBookingListener();
  scheduleReminderCheck(); // Start reminder scheduling
});

client.on("authenticated", () => {
  logger.info("AUTHENTICATED - WhatsApp session authenticated");
  currentStatus = "Authenticated";
  io.emit("status", currentStatus);
});

client.on("auth_failure", (msg) => {
  logger.error("AUTHENTICATION FAILURE: " + JSON.stringify(msg));
  currentStatus = "Not authenticated - Authentication failed, please scan QR code";
  io.emit("status", currentStatus);
  client.initialize().catch((err) => logger.error("Client reinitialization error: " + err.message));
});

client.on("disconnected", async (reason) => {
  logger.info("DISCONNECTED - Reason: " + reason);
  currentStatus = "Not authenticated - Disconnected, please scan QR code";
  isClientReady = false; // Mark client as not ready
  io.emit("status", currentStatus);
  try {
    await client.destroy();
    await deleteSessionFolder();
    setTimeout(() => {
      logger.info("Reinitializing WhatsApp client...");
      client.initialize().catch((err) => logger.error("Client reinitialization error: " + err.message));
    }, 10000);
  } catch (err) {
    logger.error("Error handling disconnection: " + err.message);
  }
});

// Initialize WhatsApp client
client.initialize().catch((err) => {
  logger.error("Client initialization error: " + err.message);
});

// Socket.IO connection
io.on("connection", (socket) => {
  logger.info("New client connected (Socket.IO)");
  if (currentQr) socket.emit("qr", currentQr);
  socket.emit("status", currentStatus);

  socket.on("disconnect", () => {
    logger.info("Client disconnected (Socket.IO)");
  });
});

// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});
