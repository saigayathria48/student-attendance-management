# Jenkins test harness

This directory contains an optional local Jenkins controller image, initialization scripts and an example pipeline job. The repository `Jenkinsfile` requires a Linux agent with Node.js 22.23.2, Chrome and ChromeDriver, Docker, kubectl, and access to a dedicated test cluster and namespace. Configure the pipeline parameters for your own registry image, Jenkins registry credential ID, Kubernetes context, namespace, test URL and test-account credential ID. Never commit passwords or tokens; manage them through Jenkins credentials. The example job configuration uses local demonstration defaults and must be adapted to the environment where it runs.

The controller image can be built with:

```powershell
docker build -f jenkins/Dockerfile -t attendance-jenkins:local jenkins
```

The optional harness mounts the Docker socket and runs a controller with elevated privileges; use it only in an isolated environment. Kubernetes setup, registry access, job creation, credentials and the test database are operator prerequisites. No fresh Jenkins run is implied by these files.
