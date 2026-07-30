# Dockerfile
# SAR change-detection compute image for WildfireDashboard's mark-for-
# acquisition workflow. Adapted from the LAwildfireSAR portfolio project's
# own Dockerfile (same base: Ubuntu + GDAL + ESA SNAP for RTC processing) -
# see SAR_METHODOLOGY.md for the full reasoning behind reusing this stack
# rather than building something new.
#
# Runs as a single AWS Batch (Fargate) job per confirmed fire - takes a
# FIRE_ID, fetches everything else (perimeter, selected scenes, mode) from
# the WildfireDashboard backend's own public API. No CDSE track search
# happens here - the human already picked exact scenes via the picker UI.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y \
    python3.11 \
    python3.11-dev \
    python3-pip \
    gdal-bin \
    libgdal-dev \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3.11 /usr/bin/python3 && \
    ln -sf /usr/bin/python3 /usr/bin/python

# SNAP headless (GPT only) - required for pyroSAR RTC processing
RUN wget -q https://download.esa.int/step/snap/10_0/installers/esa-snap_sentinel_unix_10_0.sh \
    -O /tmp/snap_installer.sh && \
    chmod +x /tmp/snap_installer.sh && \
    /tmp/snap_installer.sh -q -dir /opt/snap && \
    rm /tmp/snap_installer.sh

ENV PATH="/opt/snap/bin:${PATH}"

WORKDIR /app

COPY requirements.txt .
RUN GDAL_VERSION=$(gdal-config --version) && \
    pip install --no-cache-dir GDAL==${GDAL_VERSION} && \
    pip install --no-cache-dir -r requirements.txt

COPY pipeline/ pipeline/
COPY entrypoint.py .

# All configuration (FIRE_ID, WILDFIRE_API_BASE_URL, CDSE_USER,
# CDSE_PASSWORD, S3_BUCKET) comes from the Batch job's environment - no
# .env file baked into the image, no AWS credentials handled directly
# (relies on the Fargate task's IAM role via boto3's default credential
# chain, not explicit access keys).
CMD ["python", "entrypoint.py"]
