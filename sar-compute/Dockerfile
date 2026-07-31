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

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-dev \
    python3-pip \
    gdal-bin \
    libgdal-dev \
    gcc \
    g++ \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3 /usr/bin/python

# SNAP headless (GPT only) - required for pyroSAR RTC processing.
# Version pinned explicitly: ESA moves old installers off STEP when they
# cut a new release (10.0's path 404s as of this writing; 13.0.0 is
# current), so this URL will need revisiting again in the future.
RUN wget -q https://download.esa.int/step/snap/13.0/installers/esa-snap_sentinel_linux-13.0.0.sh \
    -O /tmp/snap_installer.sh && \
    chmod +x /tmp/snap_installer.sh && \
    /tmp/snap_installer.sh -q -dir /opt/snap && \
    rm /tmp/snap_installer.sh

ENV PATH="/opt/snap/bin:${PATH}"

WORKDIR /app

COPY requirements.txt .
# Ubuntu 24.04's system pip refuses unmanaged installs by default (PEP 668);
# safe to override here since this container only ever runs this one pinned
# dependency set - it is not a general-purpose dev environment.
# --ignore-installed is also required: gdal-bin hard-depends on
# python3-gdal, which apt/dpkg installs its own numpy for - pip can't
# uninstall a dpkg-managed package (no RECORD file) when resolving our
# pinned numpy==2.4.2, so tell it to overwrite in place instead.
RUN GDAL_VERSION=$(gdal-config --version) && \
    pip install --no-cache-dir --break-system-packages --ignore-installed GDAL==${GDAL_VERSION} && \
    pip install --no-cache-dir --break-system-packages --ignore-installed -r requirements.txt

COPY pipeline/ pipeline/
COPY entrypoint.py .

# All configuration (FIRE_ID, WILDFIRE_API_BASE_URL, CDSE_USER,
# CDSE_PASSWORD, S3_BUCKET) comes from the Batch job's environment - no
# .env file baked into the image, no AWS credentials handled directly
# (relies on the Fargate task's IAM role via boto3's default credential
# chain, not explicit access keys).
CMD ["python", "entrypoint.py"]
