import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let openai: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not set in .env — required for voice transcription');
    }
    openai = new OpenAI({ apiKey });
  }
  return openai;
}

/**
 * Transcribe base64 audio using OpenAI Whisper API.
 * Returns the transcribed text.
 */
export async function transcribeAudio(base64Audio: string, format: string): Promise<string> {
  const client = getClient();

  // Determine file extension from format
  const extMap: Record<string, string> = {
    'audio/m4a': '.m4a',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/webm': '.webm',
  };
  const ext = extMap[format] || '.m4a';

  // Save to temp file (Whisper API needs a file)
  const tempFile = path.join(os.tmpdir(), `voice-${Date.now()}${ext}`);
  fs.writeFileSync(tempFile, Buffer.from(base64Audio, 'base64'));

  try {
    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempFile),
      model: 'whisper-1',
    });
    return transcription.text;
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tempFile); } catch {}
  }
}
