import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { Client } from 'basic-ftp';
import { Readable } from 'stream';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.post('/api/deploy', async (req: Request, res: Response) => {
    const { host, user, password, htmlString, targetFolder = 'public_html' } = req.body;

    if (!host || !user || !password || !htmlString) {
        return res.status(400).json({ error: 'Missing required FTP parameters or HTML content.' });
    }

    const client = new Client();
    client.ftp.verbose = true; 

    try {
        await client.access({
            host,
            user,
            password,
            secure: false
        });

        await client.ensureDir(targetFolder);

        const stream = Readable.from([htmlString]);
        await client.uploadFrom(stream, 'index.html');

        res.status(200).json({ success: true, message: 'Website successfully deployed live!' });
    } catch (error) {
        console.error('FTP Deployment Error:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    } finally {
        client.close();
    }
});

// Add this route to server.ts in sae-ftp-bridge
app.post('/api/generate', async (req: Request, res: Response) => {
    try {
        const { prompt, pageTitle, slogan } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not set on the server.' });
        }

        const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `You are an expert web developer and designer. Generate a complete, standalone, beautiful HTML5 page (including internal CSS style block) based on this user prompt: "${prompt}". 
                        Use these details as the core content:
                        - Page Title: "${pageTitle}"
                        - Slogan: "${slogan}"
                        Return ONLY valid raw HTML code starting with <!DOCTYPE html>. Do not wrap it in markdown code blocks or conversational text.`
                    }]
                }]
            })
        });

        const data = await geminiResponse.json();

        // Check if Google returned an error response
        if (!geminiResponse.ok) {
            return res.status(500).json({ success: false, error: data.error?.message || 'Unknown Google AI Error' });
        }

        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleanHtml = rawText.replace(/```html/g, '').replace(/```/g, '').trim();

        res.json({ success: true, html: cleanHtml });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`SAE FTP bridge listening on port ${PORT}`);
});