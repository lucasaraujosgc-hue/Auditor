# Use Node.js as the base image
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package.json and install production dependencies
COPY package*.json ./
RUN npm install --production

# Copy built files and server script
COPY --from=builder /app/dist ./dist
COPY server.js ./

# Create backup directory
RUN mkdir -p /backup

# Set port and environment
ENV PORT=80
ENV NODE_ENV=production

# Expose port 80
EXPOSE 80

# Start Node.js server
CMD ["node", "server.js"]
