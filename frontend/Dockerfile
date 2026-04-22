FROM node:20-alpine

WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json* ./
RUN npm install

# Copy application code
COPY . .

# Next.js telemetry disable is generally good for docker
ENV NEXT_TELEMETRY_DISABLED 1

# Expose the port
EXPOSE 3000

# Start the application in development mode with hot-reloading
CMD ["npm", "run", "dev"]
