const { spawn } = require('child_process');
const microsoftSpeechSdk = require('microsoft-cognitiveservices-speech-sdk');
const WebSocket = require('ws');
const http = require('http');
const express = require('express');

// Create the WebSocket server (noServer so we control routing)
const wss = new WebSocket.Server({ noServer: true });
// Send periodic ping to keep connection alive
const KEEPALIVE_INTERVAL_MS = 30000;
function noop() {}

function heartbeat() {
  this.isAlive = true;
}

const app = express();
const server = http.createServer(app);

let clients = [];
let isPaused = false;
let running = false;
let lastRecognizedTime = Date.now();

// Replace these with your Twitch credentials
const clientId = 'hki5vmecwl8hjpkuyyc0cwv8jmt4u3';
const clientSecret = 'ocr4kl5r3yl6e8bucgdhnoyk6hywex';

// Your Azure Speech API credentials
const azureSubscriptionKey = '60qW32SpB3ZenZAMEQXvU5r8Lu4DspLuQ2Xb6nFTs72L8mkHBPSBJQQJ99AKAC1i4TkXJ3w3AAAYACOGJ0Vc';  // Replace with your Azure Subscription Key
const azureRegion = 'centralus';  // Replace with your Azure region (e.g., 'eastus')

// Configure Azure Speech-to-Text
const speechConfig = microsoftSpeechSdk.SpeechConfig.fromSubscription(azureSubscriptionKey, azureRegion);
speechConfig.speechRecognitionLanguage = 'en-US';
// Disable profanity filtering
speechConfig.setProfanity(microsoftSpeechSdk.ProfanityOption.Raw);
speechConfig.setProperty("EndSilenceTimeoutMs", "250");

let recognizer;

// Function to monitor and transcribe Twitch audio
function monitorStreamAndTranscribe(streamer) {
  console.log(`Monitoring stream: ${streamer}`);

  let streamUrl = `https://www.twitch.tv/${streamer}`;

  // Command to fetch the audio stream with Streamlink
  const streamlinkCommand = `streamlink --stdout --twitch-low-latency ${streamUrl} audio_only`;

  const stream = spawn(streamlinkCommand, {
    shell: true,
  });

  // Create a PushStream for Azure Audio Input
  const pushStream = microsoftSpeechSdk.AudioInputStream.createPushStream();

  // Set up the speech recognizer to use the push stream
  const audioConfig = microsoftSpeechSdk.AudioConfig.fromStreamInput(pushStream);
  recognizer = new microsoftSpeechSdk.SpeechRecognizer(speechConfig, audioConfig);

  let partialBuffer = '';

  // Handle speech recognition results
  recognizer.recognizing = (s, e) => {
    if (e.result && e.result.text) {
      running = true;
      lastRecognizedTime = Date.now(); // ✅ Reset watchdog timer on new recognition

      if (!isPaused) {
        const partial = e.result.text.toLowerCase();
        console.log("Partial speech: " + partial);
        partialBuffer += ' ' + partial;

        if (partialBuffer.includes("guinea pig bridge") || partialBuffer.includes("any big bridge") || partialBuffer.includes("any pig bridge") || 
        ((partialBuffer.includes("guinea") || partialBuffer.includes("any")) && (partialBuffer.includes("pig") || partialBuffer.includes("big")) && partialBuffer.includes("bridge"))) {
          console.log("🎯 Phrase detected (partial)");
          console.log ("------------------PAUSING------------------");
          partialBuffer = ''; // Clear to avoid re-detection

          isPaused = true;
          setTimeout(() => {
            console.log("------------------UNPAUSING------------------");
            isPaused = false;
          }, 60000);

          for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send('play');
            } else {
              clients.delete(ws);
            }
          }
        }

        // Optional: trim buffer
        if (partialBuffer.length > 500) {
          partialBuffer = partialBuffer.slice(-500);
        }
      }
    }
  };

  recognizer.recognized = (s, e) => {
    if (e.result.reason === microsoftSpeechSdk.ResultReason.RecognizedSpeech) {
      const recognizedText = e.result.text;
      console.log(`${streamer}: Recognized speech: ${recognizedText}`);
      lastRecognizedTime = Date.now(); // ✅ Reset watchdog timer on new recognition

      // Check if the word "guinea pig bridge" is in the recognized text
      if (!isPaused) {
        let textLower = recognizedText.toLowerCase();
        if (textLower.includes("guinea pig bridge") || textLower.includes("any big bridge") || textLower.includes("any pig bridge") || 
        ((textLower.includes("guinea") || textLower.includes("any")) && (textLower.includes("pig") || textLower.includes("big")) && textLower.includes("bridge"))) {
          console.log("Specific word detected in audio!");
          console.log("------------------PAUSING------------------");
          // Optionally broadcast to all clients
          //pauseRecognizer();
          isPaused = true;

          setTimeout(() => {
            //resumeRecognizer();
            console.log("------------------UNPAUSED------------------");
            isPaused = false;
          }, 60000)
          for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send('play');
            } else {
              clients.delete(ws); // remove dead connection
            }
          }
        }
      }
    }
  };

  recognizer.canceled = (s, e) => {
    running = false;
    console.log('Speech recognition canceled:', e.errorDetails);
  };

  recognizer.sessionStarted = () => {
    console.log('Speech session started.');
  };

  recognizer.sessionStopped = () => {
    running = false;
    console.log('Speech session stopped.');
  };

  // Start continuous recognition
  recognizer.startContinuousRecognitionAsync();

  // Use ffmpeg to transcode and filter audio to 16kHz, mono-channel PCM
  const ffmpegCommand = spawn('ffmpeg', [
  '-loglevel', 'error',
  '-fflags', 'nobuffer',
  '-flags', 'low_delay',
  '-probesize', '512000',        // default is 5MB = 5000000, this is 0.5MB
  '-analyzeduration', '1000000', // 1 second max
  '-i', 'pipe:0',
  '-vn',
  '-ac', '1',
  '-ar', '16000',
  '-f', 'wav',
  'pipe:1'
  ]);

  // Pipe streamlink's output into ffmpeg
  stream.stdout.pipe(ffmpegCommand.stdin);

  // Stream the audio data from ffmpeg to Azure Speech-to-Text
  ffmpegCommand.stdout.on('data', (data) => {
    // Write the audio data into the PushStream
      pushStream.write(data);
  });

  // Also handle ffmpeg close, you can add similar restart logic if you want
  ffmpegCommand.on('close', (code) => {
    console.log(`FFmpeg process closed with code: ${code}`);
    pushStream.close();
    recognizer.stopContinuousRecognitionAsync(() => {
      console.log('Recognizer stopped due to FFmpeg close.');
    });

  });ffmpegCommand.stderr.on('data', (data) => {
  console.error(`FFmpeg error: ${data.toString()}`);
});

  stream.on('close', (code) => {
    console.log(`Stream closed for ${streamUrl} with code: ${code}`);
    console.log('Restarting monitoring in 5 minutes...');
    
    // Stop recognizer safely
    if (recognizer) {
      recognizer.stopContinuousRecognitionAsync(() => {
        console.log('Recognizer stopped due to stream close.');
      });
    }

    // Wait 5 minutes and then restart
    setTimeout(() => {
      monitorStreamAndTranscribe(streamer);
    }, 300000);
  });
}

// Function to pause the recognizer for a specific streamer
function pauseRecognizer() {
  if (recognizer) {
    recognizer.stopContinuousRecognitionAsync(() => {
      console.log(`Recognizer paused.`);
    });
  } else {
    console.log(`Recognizer not found.`);
  }
}

// Function to resume the recognizer for a specific streamer
function resumeRecognizer() {
  if (recognizer) {
    recognizer.startContinuousRecognitionAsync(() => {
      console.log(`Recognizer resumed.`);
    });
  } else {
    console.log(`Recognizer not found.`);
  }
}

// Serve regular HTTP routes if needed
app.get('/', (req, res) => {
  res.send('WebSocket server is running');
});

// Handle WebSocket upgrades manually
server.on('upgrade', (request, socket, head) => {
  const { url } = request;

  console.log(`Incoming WS request: ${url}`);

  // You can restrict routes here
  if (url === '/filian') {//|| url === '/play' || url === '/chat') {
    wss.handleUpgrade(request, socket, head, ws => {
      ws.route = url; // Attach route to ws instance
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy(); // Reject unknown routes
  }
});

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  console.log(`New WebSocket connection on ${ws.route}`);

  ws.isAlive = true;
  ws.on('pong', heartbeat); // Listen for pongs to confirm client is alive

  ws.send(`Connected via ${ws.route}`);
  clients.push(ws);
  console.log('Client connected. Total:', clients.length);

  ws.on('message', message => {
    console.log(`[${ws.route}] Message: ${message}`);
    let data = JSON.parse(message);
  });

  ws.on('close', () => {
    console.log(`Connection on ${ws.route} closed`);
    // Remove from list on disconnect
    clients = clients.filter(client => client !== ws);
    console.log('Client disconnected. Total:', clients.length);
  });
});

// Interval to ping all clients
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminating unresponsive client');
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping(noop); // Send ping frame; client should respond with pong
  });
}, KEEPALIVE_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(interval);
});

// Start server
server.listen(3001, () => {
  console.log('Server listening on port 3001');
});

setInterval(() => {
  const now = Date.now();
  const timeSinceLast = (now - lastRecognizedTime) / 1000;
  console.log("-Still listening-");

  if (timeSinceLast > 60 && running) { // ⏱️ 120 seconds = 2 minutes of silence
    console.warn(`[${new Date().toLocaleTimeString()}] No speech detected in ${Math.round(timeSinceLast)}s. Restarting recognizer.`);

    recognizer.stopContinuousRecognitionAsync(() => {
      recognizer.startContinuousRecognitionAsync(() => {
        console.log(`[${new Date().toLocaleTimeString()}] Recognizer restarted.`);
        lastRecognizedTime = Date.now(); // reset timer after restart
      });
    });
  }
}, 30000); // check every 30 seconds

// Main function to execute the script
(async function main() {
  try {
      monitorStreamAndTranscribe('blurbsbuilds');
  } catch (error) {
    console.error('An error occurred:', error.message);
  }
})();