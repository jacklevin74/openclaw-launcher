FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
COPY public/ ./public/
EXPOSE 8780
CMD ["node", "dist/server.js"]
