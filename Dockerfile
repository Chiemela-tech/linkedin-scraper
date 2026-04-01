# Use the official Apify image for Playwright with Chrome
FROM apify/actor-node-playwright-chrome:20

# Copy package.json and package-lock.json to the container
COPY package*.json ./

# Install dependencies
RUN npm install --include=dev --quiet \
    && echo "Node.js dependencies installed."

# Copy the rest of the code
COPY . ./

# Run the script
CMD [ "npm", "start" ]
