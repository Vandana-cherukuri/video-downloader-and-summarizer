  // ✅ Use imports (ESM style)
  import express from "express";
  import cors from "cors";
  import bodyParser from "body-parser";
  import { exec } from "child_process";
  import fs from "fs";
  import path from "path";
  import { fileURLToPath } from "url";
  import { GoogleGenerativeAI } from "@google/generative-ai";
  import { YoutubeTranscript } from "youtube-transcript";
  import ytdl from "ytdl-core";
  import dotenv from "dotenv";

  dotenv.config();

  const app = express();
  const PORT = process.env.PORT || 3000;

  // Fix __dirname in ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const DOWNLOADS_DIR = path.join(__dirname, "downloads");

  // Ensure downloads folder exists
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR);
  }

  // Middleware
  app.use(cors());
  app.use(bodyParser.json());
  app.use(express.json());
  app.use(express.static("public"));
  app.use("/downloads", express.static(DOWNLOADS_DIR));

  // ------------------- HELPERS -------------------
  function sanitizeFilename(filename) {
    return filename.replace(/[^\w\s.-]/gi, "").replace(/\s+/g, "_").substring(0, 100);
  }

  function formatDuration(seconds) {
    if (!seconds) return "Unknown";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  function formatFileSize(bytes) {
    const sizes = ["Bytes", "KB", "MB", "GB"];
    if (!bytes || bytes <= 0) return "Unknown";
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + " " + sizes[i];
  }

  // ------------------- YOUTUBE DOWNLOAD (VIDEO) -------------------
  app.post("/api/download", (req, res) => {
    const { url, format = "mp4" } = req.body;

    if (!url) {
      return res.status(400).json({ error: "No URL provided" });
    }

    const filename = `video_${Date.now()}.${format}`;
    const filepath = path.join(DOWNLOADS_DIR, filename);

    // yt-dlp command to download with proper audio+video
    const command = `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4" --merge-output-format mp4 -o "${filepath}" ${url}`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Download error:", stderr);
        return res.status(500).json({ error: "Download failed" });
      }

      console.log("Downloaded:", filepath);

      res.json({
        message: "Download successful",
        file: filename,
        downloadUrl: `/downloads/${filename}`,
      });
    });
  });

  // ------------------- YOUTUBE DOWNLOAD (AUDIO MP3) -------------------
  app.post("/api/download-audio", (req, res) => {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "No URL provided" });
    }

    const filename = `audio_${Date.now()}.mp3`;
    const filepath = path.join(DOWNLOADS_DIR, filename);

    // yt-dlp command to extract audio as mp3
    const command = `yt-dlp -x --audio-format mp3 -o "${filepath}" "${url}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Audio download error:", stderr);
        return res.status(500).json({ error: "Audio download failed" });
      }

      console.log("Audio downloaded:", filepath);

      res.json({
        message: "Audio download successful",
        file: filename,
        downloadUrl: `/downloads/${filename}`,
      });
    });
  });

  // ------------------- VIDEO INFO (YTDL) -------------------
  app.get("/api/video-info/:id", async (req, res) => {
    try {
      const videoId = req.params.id;
      const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);

      res.json({
        title: info.videoDetails.title,
        author: info.videoDetails.author.name,
        description: info.videoDetails.description,
        length: formatDuration(info.videoDetails.lengthSeconds),
        views: info.videoDetails.viewCount,
      });
    } catch (error) {
      console.error("Video info fetch error:", error);
      res.status(500).json({ error: "Failed to fetch video info" });
    }
  });

  // ------------------- SUMMARIZATION (Gemini + Transcript) -------------------
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  async function summarizeVideo(transcript) {
    const prompt = `Summarize the following YouTube transcript clearly and concisely:\n\n${transcript}`;
    const result = await model.generateContent(prompt);
    return result.response.text();
  }
app.post("/api/summarize", async (req, res) => {
  try {
    const { url, filename } = req.body;

    let transcript = "";

    if (filename) {
      // Case: already downloaded audio file
      transcript = await transcribeWithGemini(filename);
    } else if (url) {
      // Case: no file yet, fallback to URL itself
      transcript = `Transcript not available for direct URL: ${url}`;
    }

    if (!transcript) transcript = "Transcript not available.";

    res.json({
      transcript,
      summary: transcript  // 👈 Make summary same as transcript
    });
  } catch (err) {
    console.error("Summarize error:", err);
    res.status(500).json({ error: "Failed to generate transcript/summary" });
  }
});


  // ------------------- AUDIO TRANSCRIPTION (Gemini) -------------------
app.post("/api/transcribe-audio", async (req, res) => {
  try {
    const { filename } = req.body;

    if (!filename) {
      return res.status(400).json({ error: "No filename provided" });
    }

    const filepath = path.join(DOWNLOADS_DIR, filename);

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: "File not found" });
    }

    // Read audio file and encode as base64
    const audioBase64 = fs.readFileSync(filepath).toString("base64");

    // ✅ Properly structured Gemini request
    const result = await model.generateContent([
      { text: "Please transcribe this audio into text:" },
      {
        inlineData: {
          mimeType: "audio/mp3", // or audio/wav depending on the file
          data: audioBase64,
        },
      },
    ]);

    const transcript = result.response.text();

    res.json({
      message: "Transcription successful",
      transcript,
    });
  } catch (error) {
    console.error("Gemini transcription error:", error);
    res.status(500).json({ error: "Transcription failed" });
  }
});
// ------------------- SUMMARIZATION (Gemini + Transcript + Audio) -------------------
app.post("/api/summarize", async (req, res) => {
  try {
    const { url, filename } = req.body; // ✅ accept both URL and filename
    let transcriptText = "";

    // 1. Try AUDIO transcript first (if filename provided)
    if (filename) {
      const filepath = path.join(DOWNLOADS_DIR, filename);
      if (fs.existsSync(filepath)) {
        try {
          const audioBase64 = fs.readFileSync(filepath).toString("base64");

          const result = await model.generateContent([
            { text: "Please transcribe this audio into text:" },
            {
              inlineData: {
                mimeType: "audio/mp3", // change if wav, m4a, etc.
                data: audioBase64,
              },
            },
          ]);

          transcriptText = result.response.text();
          console.log("✅ Used Gemini Audio Transcript");
        } catch (err) {
          console.warn("Audio transcription failed, fallback to YouTube transcript...");
        }
      }
    }

    // 2. If AUDIO transcript not available, fetch YouTube transcript
    if (!transcriptText && url) {
      try {
        const transcript = await YoutubeTranscript.fetchTranscript(url);
        transcriptText = transcript.map((item) => item.text).join(" ");
        console.log("✅ Used YouTube Transcript");
      } catch (err) {
        console.warn("Transcript not available, falling back to metadata...");
        transcriptText = `This is a YouTube video: ${url}. Please summarize it based on its title, metadata, and general knowledge.`;
      }
    }

    // 3. Summarize final transcript
    const summary = await summarizeVideo(transcriptText);

    res.json({
      transcript: transcriptText, // ✅ Include transcript in response
      summary,
    });
  } catch (error) {
    console.error("Summarization error:", error);
    res.status(500).json({ error: error.message });
  }
});


  // ------------------- START SERVER -------------------
  app.listen(PORT, () => {
    console.log(`✅ Video Downloader Backend running on port ${PORT}`);
    console.log(`Access API at: http://localhost:${PORT}`);
  });

  export default app;
