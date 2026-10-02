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
// Add this route to server.ts in sae-ftp-bridge
app.post('/api/generate', async (req: Request, res: Response) => {
    try {
        // FIX: We must extract currentHtml alongside the prompt!
        const { prompt, currentHtml } = req.body; 
        const apiKey = process.env.OPENROUTER_API_KEY;

        if (!apiKey) {
            return res.status(500).json({ success: false, error: 'OPENROUTER_API_KEY is missing' });
        }

        // FIX: Combine the instructions and the existing HTML so the AI knows what to modify
        const fullPrompt = `${prompt}\n\nCURRENT HTML TO MODIFY:\n${currentHtml}`;

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "openai/gpt-4o", 
                messages: [
                    { role: "user", content: fullPrompt } // Send the combined text
                ]
            })
        });

        const data = await response.json();
        
        if (data.error) throw new Error(data.error.message);

        return res.json({ 
            success: true, 
            html: data.choices[0].message.content 
        });

    } catch (error: any) {
        console.error('AI Generation Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`SAE FTP bridge listening on port ${PORT}`);
});