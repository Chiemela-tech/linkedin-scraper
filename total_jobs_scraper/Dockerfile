FROM apify/actor-python-playwright-chrome:latest

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && echo "Python dependencies installed."

COPY . ./

CMD [ "python", "main.py" ]
