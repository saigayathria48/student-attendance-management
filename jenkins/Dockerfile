# Local Jenkins image for executing this repository's Jenkinsfile against the
# dedicated kind cluster. Build from the repository root:
#   docker build -f jenkins/Dockerfile -t attendance-jenkins:local jenkins
FROM jenkins/jenkins:lts-jdk21

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates xz-utils unzip chromium chromium-driver \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22.23.2 and npm 12.0.2, matching the recorded application environment.
RUN curl -fsSL https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && npm install -g npm@12.0.2 \
    && node --version && npm --version

# Docker CLI (client only; the host daemon is mounted into the container).
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-29.8.2.tgz -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp --strip-components=1 docker/docker \
    && mv /tmp/docker /usr/local/bin/docker \
    && chmod +x /usr/local/bin/docker \
    && rm /tmp/docker.tgz \
    && docker --version

RUN curl -fsSLo /usr/local/bin/kubectl https://dl.k8s.io/release/v1.37.0/bin/linux/amd64/kubectl \
    && chmod +x /usr/local/bin/kubectl \
    && kubectl version --client

RUN git config --global --add safe.directory '*'

COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt

COPY init.groovy.d/ /usr/share/jenkins/ref/init.groovy.d/

ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false -Dhudson.plugins.git.GitSCM.ALLOW_LOCAL_CHECKOUT=true"

USER jenkins
