FROM node:22

# Install poppler-utils to convert PDF to image (pdftoppm)
RUN apt-get update && apt-get install -y poppler-utils

# Set working directory
WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy project files
COPY . .

# Expose port used by the app
EXPOSE 3000

# Start the server
CMD ["npm", "start"]
