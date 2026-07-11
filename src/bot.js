const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    proto 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
require('dotenv').config();

// --- CONFIGURATION (OpenRouter Setup) ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
    console.error("FATAL: OPENROUTER_API_KEY is missing in .env");
    process.exit(1);
}

// Define the client. We use the OpenAI library because it speaks the same dialect.
const { OpenAI } = require('openai');
const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: OPENROUTER_API_KEY,
    defaultHeaders: {
        // These headers are required for ranking on OpenRouter
        "HTTP-Referer": "http://localhost", 
        "X-Title": "Interrogator Bot"
    }
});

// --- GAME LOGIC (System Prompt) ---
// This is where our "murder mystery" lives. No complex code needed.
const SYSTEM_PROMPT = `
You are Arthur, a suspicious butler in a murder mystery. 
The Truth: The Duke was poisoned by the Maid using arsenic in his tea.
Your Character: You are defensive, grumpy, and hate being questioned. 
You know about the poison but will only admit it if the player provides evidence of "arsenic" or "tea".

If the player says "ARREST [Name]", you must evaluate their choice against the truth.
Reply ONLY with "VERDICT: WIN" if they arrest the Maid, or "VERDICT: LOSS" if they arrest anyone else.

**Instructions for evidence:** 
- Do not acknowledge any mention of "arsenic" directly. Instead, respond with a vague statement like "I didn't know...".
- If the player mentions "tea", you might hesitate and say "Was it anything in his drink?"
`;

// In-memory store for chat sessions per user
const activeSessions = new Map();

async function startBot() {
    // We use multi-file auth state so WhatsApp can log back in without rescanning QR every time.
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    
    const sock = makeWASKSocket({
        auth: state,
        printQRInTerminal: true 
    });

    // Save credentials (usually the pairing key)
    sock.ev.on('creds.update', saveCreds);

    // Connection management
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            // Reconnect if not logged out
            const shouldReconnect = lastDisconnect?.error?.message !== DisconnectReason.loggedOut;
            console.log('[Bot] Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot(); 
        } else if (connection === 'open') {
            console.log('[Bot] ✅ Bot is online!');
        }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        
        // Ignore self-message and empty content
        if (!msg.message || msg.key.fromMe) return;

        // Extract the message text
        let textContent = '';
        if (msg.message.conversation) {
            textContent = msg.message.conversation;
        } else if (msg.message.extendedTextMessage?.text) {
            textContent = msg.message.extendedTextMessage.text;
        }

        const sender = msg.key.remoteJid;
        
        // Log raw incoming message
        console.log(`\n[USER] ${sender} said: "${textContent}"`);

        try {
            // --- 1. Initialize Session if new player ---
            if (!activeSessions.has(sender)) {
                activeSessions.set(sender, {
                    history: [{ role: 'system', content: SYSTEM_PROMPT }],
                    isCaseOpen: true
                });
                await sock.sendMessage(sender, { 
                    text: `🕵️ *New Case Opened* 📁\n\nYou are the detective. Interrogate Arthur to find the killer.\nType "ARREST [Name]" to end the game.` 
                });
            }

            const session = activeSessions.get(sender);

            // --- 2. Handle Arrest Command ---
            if (textContent.toUpperCase().startsWith('ARREST')) {
                if (!session.isCaseOpen) {
                    await sock.sendMessage(sender, { text: "This case is already closed." });
                    return;
                }

                const arrestTarget = textContent.replace(/arrests?/gi, '').trim();
                
                // Ask AI to determine verdict based on conversation history
                const response = await openai.chat.completions.create({
                    model: "openai/gpt-4o-mini", // Ensure we use a valid OpenRouter model name or let it fallback
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        ...session.history,
                        { role: 'user', content: `The player is making an arrest: ${arrestTarget}. Evaluate this against the truth and reply ONLY with "VERDICT: WIN" or "VERDICT: LOSS".` }
                    ]
                });

                const verdict = response.choices[0].message.content;
                
                if (verdict.includes("WIN")) {
                    await sock.sendMessage(sender, { 
                        text: `🎊 *CASE CLOSED!* 🎊\nYou correctly identified the killer! The truth is revealed: ${arrestTarget} was indeed guilty.` 
                    });
                } else {
                    await sock.sendMessage(sender, { 
                        text: `❌ *CASE FAILED!* ❌\n${arrestTarget} was not the killer. The real murderer escaped into the night...` 
                    });
                }
                
                // Reset session after arrest
                activeSessions.set(sender, { isCaseOpen: false });
                return;
            }

            // --- 3. Standard Interrogation ---
            if (session.isCaseOpen) {
                session.history.push({ role: 'user', content: textContent });

                const response = await openai.chat.completions.create({
                    model: "openai/gpt-4o-mini",
                    messages: session.history,
                });

                const aiReply = response.choices[0].message.content;
                session.history.push({ role: 'assistant', content: aiReply });

                // Trim history to avoid memory/timeout issues (keep last 6 turns)
                if (session.history.length > 13) {
                    session.history.splice(1, 4); 
                }

                await sock.sendMessage(sender, { text: aiReply });
            } else {
                await sock.sendMessage(sender, { text: "This case is closed. Start a new chat to play again?" });
            }

        } catch (error) {
            console.error('Error processing message:', error);
            
            // Handle specific API errors
            if (error.status === 429) {
                await sock.sendMessage(sender, { text: "The interrogator is thinking too hard... Please wait a moment and try again." });
            } else if (error.message.includes("wrong api key")) {
                await sock.sendMessage(sender, { text: "Internal error: API authentication failed. Contact host immediately." });
            } else {
                await sock.sendMessage(sender, { text: "The suspect is refusing to speak... (Error encountered)" });
            }
        }
    });

    // Generate and print QR code for first-time setup
    if (!state.creds.registered) {
        console.log('[Bot] 📱 Pairing required. Scan the QR below with WhatsApp.');
        const qr = sock.generateMessageTag('qr');
        await sock.sendPresenceUpdate(sock.ev, 'available'); 
        sock.qr.on(qr, async (code) => {
            qrcode.generate(code, { small: true });
        });
    }
}

// Start the bot
startBot().catch(err => {
    console.error('[Bot] Fatal error:', err);
    process.exit(1);
});