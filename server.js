const { spawn } = require('child_process');
const microsoftSpeechSdk = require('microsoft-cognitiveservices-speech-sdk');
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 3001 });
let clients = [];
const express = require('express');
const app = express();
const port = 3000;

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
  const streamlinkCommand = `streamlink --stdout ${streamUrl} audio_only`;

  const stream = spawn(streamlinkCommand, {
    shell: true,
  });

  // Create a PushStream for Azure Audio Input
  const pushStream = microsoftSpeechSdk.AudioInputStream.createPushStream();

  // Set up the speech recognizer to use the push stream
  const audioConfig = microsoftSpeechSdk.AudioConfig.fromStreamInput(pushStream);
  recognizer = new microsoftSpeechSdk.SpeechRecognizer(speechConfig, audioConfig);

  // Handle speech recognition results
  recognizer.recognizing = (s, e) => {
    //console.log(`Recognizing: ${e.result.text}`);
    // We don't trigger specific word detection here anymore, it happens in `recognized` only
  };

  recognizer.recognized = (s, e) => {
    if (e.result.reason === microsoftSpeechSdk.ResultReason.RecognizedSpeech) {
      const recognizedText = e.result.text;
      console.log(`${streamer}: Recognized speech: ${recognizedText}`);
      
      // Check if the word "like" is in the recognized text and it has not been detected before
      if (recognizedText.toLowerCase().includes("like")) {
        console.log("Specific word detected in audio!");
        
        // Optionally broadcast to all clients
        pauseRecognizer();

        setTimeout(() => {
          resumeRecognizer();
        }, 70000)
        for (const ws of clients) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('play');
          } else {
            clients.delete(ws); // remove dead connection
          }
        }
      }
    }
  };

  recognizer.canceled = (s, e) => {
    console.log('Speech recognition canceled:', e.errorDetails);
  };

  recognizer.sessionStarted = () => {
    console.log('Speech session started.');
  };

  recognizer.sessionStopped = () => {
    console.log('Speech session stopped.');
  };

  // Start continuous recognition
  recognizer.startContinuousRecognitionAsync();

  // Use ffmpeg to transcode and filter audio to 16kHz, mono-channel PCM
  const ffmpegCommand = spawn('ffmpeg', [
    '-i', 'pipe:0', // input from streamlink
    '-vn',  // no video
    '-ac', '1',  // mono-channel
    '-ar', '16000',  // sample rate 16 kHz
    '-f', 'wav',  // output format wav
    'pipe:1'  // output to stdout
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
  });

  stream.on('close', (code) => {
    console.log(`Stream closed for ${streamUrl} with code: ${code}`);
    console.log('Restarting monitoring in 3 seconds...');
    
    // Stop recognizer safely
    if (recognizer) {
      recognizer.stopContinuousRecognitionAsync(() => {
        console.log('Recognizer stopped due to stream close.');
      });
    }

    // Wait 3 seconds and then restart
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

wss.on('connection', (ws) => {
  console.log('Client connected');
  clients.push(ws);
  
  ws.on('message', (message) => {
    console.log('Received: %s', message);
    let data = JSON.parse(message);
  });

  ws.on('close', () => {
    // Remove from list on disconnect
    clients = clients.filter(client => client !== ws);
    console.log('Client disconnected. Total:', clients.length);
  });
});

// Serve static files from "public" folder
app.use(express.static('public'));

// Route for /test
app.get('/test', (req, res) => {
  res.send('Hello from /test route!');
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Main function to execute the script
(async function main() {
  try {
      monitorStreamAndTranscribe('filian');
  } catch (error) {
    console.error('An error occurred:', error.message);
  }
})();