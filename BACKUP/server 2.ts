import express, { type Request, type Response } from 'express';
import cors from 'cors';
import * as ftp from 'basic-ftp';
import { Client } from 'basic-ftp';
import { Readable, Writable } from 'stream';

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

// 1. LIST DIRECTORY CONTENTS
app.post('/api/ftp/list', async (req: any, res: any) => {
    const { host, user, password, path = '/' } = req.body;
    const client = new ftp.Client();
    try {
        await client.access({ host, user, password, secure: false });
        const list = await client.list(path);
        const formattedList = list.map(item => ({
            id: `${path === '/' ? '' : path}/${item.name}`,
            name: item.name,
            isFolder: item.type === 2, // 2 is a directory
            size: item.size,
            modifiedTime: item.modifiedAt
        }));
        res.json({ success: true, files: formattedList });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.close();
    }
});

// 2. READ A FILE
app.post('/api/ftp/read', async (req: any, res: any) => {
    const { host, user, password, filePath } = req.body;
    const client = new ftp.Client();
    try {
        await client.access({ host, user, password, secure: false });
        const stream = new Writable();
        let fileContent = '';
        stream._write = function (chunk: any, encoding: any, done: any) {
            fileContent += chunk.toString();
            done();
        };
        await client.downloadTo(stream, filePath);
        res.json({ success: true, content: fileContent });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.close();
    }
});

// 3. CREATE A NEW FOLDER
app.post('/api/ftp/mkdir', async (req: any, res: any) => {
    const { host, user, password, folderPath } = req.body;
    const client = new ftp.Client();
    try {
        await client.access({ host, user, password, secure: false });
        await client.ensureDir(folderPath);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.close();
    }
});

// 4. DELETE A FILE OR FOLDER
app.post('/api/ftp/delete', async (req: any, res: any) => {
    const { host, user, password, targetPath, isFolder } = req.body;
    const client = new ftp.Client();
    try {
        await client.access({ host, user, password, secure: false });
        if (isFolder) {
            await client.removeDir(targetPath);
        } else {
            await client.remove(targetPath);
        }
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.close();
    }
});

// --- NEW: FTP IMAGE UPLOAD ENDPOINT ---
app.post('/api/ftp/upload', async (req: any, res: any) => {
    const { host, user, password, path = '/', filename, fileData } = req.body;

    if (!host || !user || !password || !filename || !fileData) {
        return res.status(400).json({ success: false, error: 'Missing required FTP credentials or file data.' });
    }

    const client = new ftp.Client();

    try {
        // Strip the browser's Base64 MIME prefix
        const base64String = fileData.replace(/^data:.*?;base64,/, '');
        
        // Convert to binary Buffer and then to a Readable Stream
        const fileBuffer = Buffer.from(base64String, 'base64');
        const stream = Readable.from(fileBuffer);

        // Connect to FTP
        await client.access({
            host: host,
            user: user,
            password: password,
            secure: false 
        });

        // Ensure directory exists and upload
        await client.ensureDir(path);
        await client.uploadFrom(stream, filename);
        client.close();

        // Construct public URL
        const baseUrl = host.toLowerCase().startsWith('ftp.') ? host.substring(4) : host;
        const publicUrl = `https://${baseUrl}${path.endsWith('/') ? path : path + '/'}${filename}`;

        return res.json({ success: true, publicUrl: publicUrl });

    } catch (error: any) {
        console.error('FTP Upload Error:', error);
        if (!client.closed) {
            client.close();
        }
        return res.status(500).json({ success: false, error: error.message || 'Failed to upload to FTP server.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`SAE FTP bridge listening on port ${PORT}`);
});