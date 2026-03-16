# ============================================================
# Dockerfile - moriesly-autocare-server
# Node.js TypeScript WebSocket & REST API Server
# ============================================================

FROM node:20-alpine

WORKDIR /app

# Salin package files terlebih dahulu agar layer caching lebih efisien
# (layer ini hanya akan di-rebuild jika package.json berubah)
COPY package*.json ./

# Install semua dependencies termasuk devDependencies
# tsx (devDependency) digunakan langsung sebagai runtime TypeScript
RUN npm install

# Salin seluruh source code TypeScript
COPY . .

# Cloud Run secara otomatis meng-inject PORT=8080
ENV PORT=3001

EXPOSE 3001

# Jalankan server langsung dengan tsx — menghindari langkah kompilasi terpisah
# Menggunakan binary lokal agar tidak bergantung pada npx dan mendapat signal handling yang benar
CMD ["node_modules/.bin/tsx", "index.ts"]
