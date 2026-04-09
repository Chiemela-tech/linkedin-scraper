# Use the official Apify image for Python with Playwright and Chrome
FROM apify/actor-python-playwright-chrome:latest

# Copy the requirements file to the container
COPY requirements.txt ./

# Install the dependencies
RUN pip install --no-cache-dir -r requirements.txt \
    && echo "Python dependencies installed."

# Copy the rest of the code
COPY . ./

# Run the script
CMD [ "python", "main.py" ]
