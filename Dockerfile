# Use the official Apify image for Playwright
FROM apify/actor-node-playwright-chromium:16

# Copy everything from the current directory to the container
COPY . ./

# Install dependencies
RUN npm install --quiet \
    && echo "Node.js dependencies installed."

# Run the script
CMD [ "npm", "start" ]
