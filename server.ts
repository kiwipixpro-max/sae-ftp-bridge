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
        const { prompt, pageTitle, slogan, currentHtml } = req.body;
        const apiKey = process.env.OPENROUTER_API_KEY;

        if (!apiKey) {
            return res.status(500).json({ success: false, error: 'OPENROUTER_API_KEY is not set on the server.' });
        }

        // DYNAMIC PROMPT: If code already exists, tell the AI to modify it. If not, build from scratch.
        const systemInstructions = currentHtml && currentHtml.length > 50
            ? `You are an expert web developer. Modify the existing HTML code below exactly as requested by this user prompt: "${prompt}".
               Ensure the core details remain intact unless specifically asked to change them:
               - Page Title: "${pageTitle}"
               - Slogan / Headline: "${slogan}"
               
               Existing HTML to modify:
               ${currentHtml}
               
               Return ONLY valid raw HTML code starting with <!DOCTYPE html>. Do not wrap it in markdown code blocks or conversational text.`
            : `You are an expert web developer and designer. Generate a complete, standalone, beautiful HTML5 page (including internal CSS style block) based on this user prompt: "${prompt}".
               Use these details as the core content:
               - Page Title: "${pageTitle}"
               - Slogan: "${slogan}"
               Return ONLY valid raw HTML code starting with <!DOCTYPE html>. Do not wrap it in markdown code blocks or conversational text.`;

        const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://sae-ftp-bridge.onrender.com',
                'X-Title': 'SAE Webpage Generator'
            },
            body: JSON.stringify({
                model: 'google/gemini-1.5-flash',
                messages: [{
                    role: 'user',
                    content: systemInstructions
                }]
            })
        });

        const data = await openRouterResponse.json();

        if (!openRouterResponse.ok) {
            return res.status(500).json({ success: false, error: data.error?.message || 'OpenRouter API Error' });
        }

        const rawText = data.choices?.[0]?.message?.content || '';
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