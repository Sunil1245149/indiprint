import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Set up directory for saving uploaded document/ID/photo files
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Database JSON path for local persistence
const DB_FILE = path.join(__dirname, 'db.json');

// Helper functions for DB operations
interface Service {
  id: string;
  service_name: string;
  service_label: string;
  price: number;
  enabled: boolean;
}

interface Shop {
  id: string;
  mobile: string;
  shop_name: string;
  password: string;
  upi_id: string;
  require_prepayment: boolean;
  services: Service[];
}

interface Upload {
  id: string;
  file_name: string;
  file_type: string;
  file_size: number;
  file_url: string;
  password?: string;
}

interface Job {
  id: string;
  shop_id: string;
  customer_name: string;
  customer_mobile: string;
  service_type: string;
  total_amount: number;
  status: 'PENDING' | 'PROCESSING' | 'PRINTED';
  payment_status: 'PENDING' | 'PAID';
  created_at: string;
  uploads: Upload[];
}

interface Database {
  shops: Shop[];
  jobs: Job[];
}

function loadDB(): Database {
  if (!fs.existsSync(DB_FILE)) {
    const initialDB: Database = { shops: [], jobs: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialDB, null, 2), 'utf-8');
    return initialDB;
  }
  try {
    const data = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Failed to parse db.json, returning empty database', err);
    return { shops: [], jobs: [] };
  }
}

function saveDB(db: Database) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write db.json', err);
  }
}

// Initialize default service templates for new shops
const DEFAULT_SERVICES: Omit<Service, 'id'>[] = [
  { service_name: 'id_card_duplex', service_label: 'ID Card Booklet Front + Back', price: 10, enabled: true },
  { service_name: 'id_card_single', service_label: 'ID Card Single Side Front', price: 5, enabled: true },
  { service_name: 'b_w_print_a4', service_label: 'B&W Document A4 Print', price: 5, enabled: true },
  { service_name: 'color_print_a4', service_label: 'Color Document A4 Print', price: 15, enabled: true },
  { service_name: 'photo_print_4x6', service_label: 'Standard Photo Card 4x6"', price: 20, enabled: true },
  { service_name: 'photo_print_a4', service_label: 'Full Poster Print A4', price: 50, enabled: true },
  { service_name: 'passport_photo_set', service_label: 'Passport Photo Set Package (8 Pics)', price: 30, enabled: true }
];

// Configure Express Middlewares
// Support up to 50MB of Base64 attachments
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- REST API ENDPOINTS ---

// 1. Authenticate / Login Merchant
app.post('/api/auth/login', (req, res) => {
  const { mobile, password } = req.body;
  if (!mobile || !password) {
    res.status(400).json({ error: 'Please input both mobile and password.' });
    return;
  }
  const db = loadDB();
  const shop = db.shops.find(s => s.mobile === mobile && s.password === password);
  if (!shop) {
    res.status(401).json({ error: 'Invalid store mobile or password.' });
    return;
  }
  // Return shop without password
  const { password: _, ...user } = shop;
  res.json({ user });
});

// 2. Register New Merchant / Shop
app.post('/api/auth/register', (req, res) => {
  const { mobile, shop_name, password, upi_id } = req.body;
  if (!mobile || !shop_name || !password || !upi_id) {
    res.status(400).json({ error: 'All parameters are required to create a store.' });
    return;
  }

  const db = loadDB();
  const existing = db.shops.find(s => s.mobile === mobile);
  if (existing) {
    res.status(400).json({ error: 'A store with this mobile number is already registered.' });
    return;
  }

  const newShopId = 'shop_' + Math.random().toString(36).substr(2, 9);
  const shopServices: Service[] = DEFAULT_SERVICES.map((s, idx) => ({
    ...s,
    id: `svc_${newShopId}_${idx}`
  }));

  const newShop: Shop = {
    id: newShopId,
    mobile,
    shop_name,
    password,
    upi_id,
    require_prepayment: false,
    services: shopServices
  };

  db.shops.push(newShop);
  saveDB(db);

  const { password: _, ...user } = newShop;
  res.status(201).json({ user });
});

// 3. Locate Store / Shop by Mobile Key
app.get('/api/shop/:mobile', (req, res) => {
  const { mobile } = req.params;
  const db = loadDB();
  const shop = db.shops.find(s => s.mobile === mobile);
  if (!shop) {
    res.status(404).json({ error: 'Store could not be located. Double check the mobile number.' });
    return;
  }
  const { password: _, ...user } = shop;
  res.json(user);
});

// 4. Retrieve Services List
app.get('/api/services/:shop_id', (req, res) => {
  const { shop_id } = req.params;
  const db = loadDB();
  const shop = db.shops.find(s => s.id === shop_id);
  if (!shop) {
    res.status(404).json({ error: 'Store not found' });
    return;
  }
  res.json(shop.services);
});

// 5. Update Services Pricing / Active Status
app.post('/api/services/update', (req, res) => {
  const { user_id, services } = req.body;
  if (!user_id || !Array.isArray(services)) {
    res.status(400).json({ error: 'Invalid services payload' });
    return;
  }
  const db = loadDB();
  const shopIdx = db.shops.findIndex(s => s.id === user_id);
  if (shopIdx === -1) {
    res.status(404).json({ error: 'Store not found' });
    return;
  }

  // Update prices & enabled flag of corresponding services
  const currentServices = db.shops[shopIdx].services;
  db.shops[shopIdx].services = currentServices.map(cs => {
    const updated = services.find((s: any) => s.service_name === cs.service_name || s.id === cs.id);
    if (updated) {
      return {
        ...cs,
        price: Number(updated.price) || cs.price,
        enabled: updated.enabled !== undefined ? Boolean(updated.enabled) : cs.enabled
      };
    }
    return cs;
  });

  saveDB(db);
  res.json({ success: true, services: db.shops[shopIdx].services });
});

// 6. Submit Job to Queue
app.post('/api/jobs/submit', (req, res) => {
  const { shop_id, customer_name, customer_mobile, service_type, total_amount, payment_status, files } = req.body;

  if (!shop_id || !customer_name || !Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: 'Invalid upload queue payload. Document files and customer name are required.' });
    return;
  }

  const db = loadDB();
  const shop = db.shops.find(s => s.id === shop_id);
  if (!shop) {
    res.status(404).json({ error: 'Target print shop not found.' });
    return;
  }

  // Generate a physical numeric ticket/token ID for easy display at Indian retail counters
  const ticketId = Math.floor(100000 + Math.random() * 900000).toString();

  // Save the Base64 files to disk
  const uploads: Upload[] = [];
  files.forEach((file: any, index: number) => {
    let base64Data = file.base64Data || '';
    // Strip metadata prefixes if present (e.g. data:image/png;base64,)
    if (base64Data.includes(';base64,')) {
      base64Data = base64Data.split(';base64,')[1];
    }

    const fileBuffer = Buffer.from(base64Data, 'base64');
    const safeFilename = `${ticketId}_${index}_${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const filePath = path.join(UPLOADS_DIR, safeFilename);

    try {
      fs.writeFileSync(filePath, fileBuffer);

      uploads.push({
        id: `upload_${ticketId}_${index}`,
        file_name: file.name,
        file_type: file.type || 'application/octet-stream',
        file_size: fileBuffer.length,
        file_url: `/api/uploads/${ticketId}/${index}/${encodeURIComponent(file.name)}`,
        password: file.password || undefined
      });
    } catch (err) {
      console.error('Failed to write file to storage', err);
    }
  });

  const newJob: Job = {
    id: ticketId,
    shop_id,
    customer_name,
    customer_mobile: customer_mobile || '',
    service_type: service_type || 'document',
    total_amount: Number(total_amount) || 0,
    status: 'PENDING',
    payment_status: payment_status || 'PENDING',
    created_at: new Date().toISOString(),
    uploads
  };

  db.jobs.push(newJob);
  saveDB(db);

  res.status(201).json({ job: newJob });
});

// 7. Download or view uploaded files
app.get('/api/uploads/:jobId/:index/:filename', (req, res) => {
  const { jobId, index } = req.params;
  const db = loadDB();
  const job = db.jobs.find(j => j.id === jobId);
  if (!job) {
    res.status(404).send('Job attachment not found.');
    return;
  }

  const upload = job.uploads[Number(index)];
  if (!upload) {
    res.status(404).send('File index not found.');
    return;
  }

  // Find corresponding file in uploads dir
  const safeFilename = `${jobId}_${index}_${upload.file_name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  const filePath = path.join(UPLOADS_DIR, safeFilename);

  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', upload.file_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(upload.file_name)}"`);
    res.sendFile(filePath);
  } else {
    res.status(404).send('Binary file deleted or expired on disk.');
  }
});

// 8. Retrieve All Jobs for Shop
app.get('/api/jobs/shop/:shop_id', (req, res) => {
  const { shop_id } = req.params;
  const db = loadDB();
  const shopJobs = db.jobs
    .filter(j => j.shop_id === shop_id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  res.json(shopJobs);
});

// 9. Update Job (Mark status / Mark payment paid direct)
app.patch('/api/jobs/:job_id', (req, res) => {
  const { job_id } = req.params;
  const { status, payment_status } = req.body;

  const db = loadDB();
  const jobIdx = db.jobs.findIndex(j => j.id === job_id);
  if (jobIdx === -1) {
    res.status(404).json({ error: 'Job ticket not found' });
    return;
  }

  if (status) {
    db.jobs[jobIdx].status = status;
  }
  if (payment_status) {
    db.jobs[jobIdx].payment_status = payment_status;
  }

  saveDB(db);
  res.json({ success: true, job: db.jobs[jobIdx] });
});

// 10. PC Printer Agent Polling Endpoint (Poll stream)
app.get('/api/jobs/agent-stream', (req, res) => {
  const { shop_mobile } = req.query;
  if (!shop_mobile) {
    res.status(400).json({ error: 'shop_mobile parameter is required for polling' });
    return;
  }

  const db = loadDB();
  const shop = db.shops.find(s => s.mobile === shop_mobile);
  if (!shop) {
    res.status(404).json({ error: 'Store not found' });
    return;
  }

  // Filter pending jobs for this shop
  const pendingJobs = db.jobs.filter(j => j.shop_id === shop.id && j.status === 'PENDING');
  res.json(pendingJobs);
});

// --- VITE & STATIC FILE SERVING INTERFACE ---

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    // Development Mode: Use Vite Middleware
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Production Mode: Serve built client files
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[IndiPrint Server] Running on http://localhost:${PORT}`);
  });
}

startServer();
