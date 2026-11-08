FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
USER node
ENV PORT=4300
EXPOSE 4300
CMD ["node", "server.js"]
