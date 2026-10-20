FROM node:20-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Build tools in case a native dependency has no prebuilt binary
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
EXPOSE 8080
CMD ["node", "src/index.js"]
