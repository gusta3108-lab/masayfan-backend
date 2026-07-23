const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
app.use(express.json());

// Permitir conexiones libres desde masifantasia.com y celulares
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

app.post('/api/crear-preferencia', async (req, res) => {
    try {
        const { items, payer, metadata } = req.body;
        
        const preference = new Preference(client);
        const result = await preference.create({
            body: {
                items: items,
                payer: payer,
                metadata: metadata,
                back_urls: {
                    success: "https://masifantasia.com",
                    failure: "https://masifantasia.com",
                    pending: "https://masifantasia.com"
                },
                auto_return: "approved",
            }
        });

        res.json({ success: true, init_point: result.init_point });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
