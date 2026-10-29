pipeline {
  agent { label 'linux' }
  options { timestamps() }
  parameters {
    string(name: 'REGISTRY_IMAGE', defaultValue: '', description: 'Registry repository for this test image, e.g. registry.example/team/attendance')
    string(name: 'REGISTRY_CREDENTIALS_ID', defaultValue: '', description: 'Jenkins username/password credentials ID for the registry')
    string(name: 'TEST_KUBE_CONTEXT', defaultValue: '', description: 'Explicit isolated Kubernetes test context')
    string(name: 'TEST_NAMESPACE', defaultValue: '', description: 'Existing isolated test namespace with persistent storage')
    string(name: 'TEST_BASE_URL', defaultValue: '', description: 'URL reachable by the Jenkins agent for Selenium')
    string(name: 'TEST_CREDENTIALS_ID', defaultValue: '', description: 'Jenkins username/password credential for the isolated test account')
    string(name: 'KIND_NODE', defaultValue: '', description: 'Optional local kind node container name; when set, the built image is imported into that node with ctr before deployment')
  }
  stages {
    stage('Checkout') {
      steps { checkout scm; sh 'mkdir -p evidence; git rev-parse HEAD > evidence/commit.txt; node --version > evidence/node-version.txt' }
    }
    stage('Install and test') {
      steps { sh 'npm ci'; sh 'npm test > evidence/automated-tests.txt 2>&1' }
    }
    stage('Build image') {
      steps {
        script {
          if (!params.REGISTRY_IMAGE?.trim()) { error('Set REGISTRY_IMAGE before publishing or deploying.') }
          env.IMAGE_TAG = "${params.REGISTRY_IMAGE}:${env.GIT_COMMIT.take(12)}-${env.BUILD_NUMBER}"
          sh 'docker build -t "$IMAGE_TAG" .; printf "%s\\n" "$IMAGE_TAG" > evidence/image-tag.txt'
        }
      }
    }
    stage('Publish image') {
      steps {
        script {
          if (!params.REGISTRY_CREDENTIALS_ID?.trim()) { error('Set REGISTRY_CREDENTIALS_ID to a Jenkins registry username/password credential.') }
          withCredentials([usernamePassword(credentialsId: params.REGISTRY_CREDENTIALS_ID, usernameVariable: 'REGISTRY_USER', passwordVariable: 'REGISTRY_PASSWORD')]) {
            sh '''set +x
              case "$IMAGE_TAG" in
                */*/*) REGISTRY_HOST="${IMAGE_TAG%%/*}" ;;
                *) REGISTRY_HOST="docker.io" ;;
              esac
              printf '%s' "$REGISTRY_PASSWORD" | docker login "$REGISTRY_HOST" --username "$REGISTRY_USER" --password-stdin
              docker push "$IMAGE_TAG"
              docker image inspect "$IMAGE_TAG" --format '{{index .RepoDigests 0}}' > evidence/image-digest.txt
              docker logout "$REGISTRY_HOST"
            '''
          }
        }
      }
    }
    stage('Load image into kind') {
      when { expression { params.KIND_NODE?.trim() } }
      steps {
        sh '''docker save "$IMAGE_TAG" | docker exec -i "$KIND_NODE" ctr -n k8s.io images import -
          docker exec "$KIND_NODE" ctr -n k8s.io images ls -q | grep -F "$IMAGE_TAG" > evidence/kind-image.txt
        '''
      }
    }
    stage('Deploy isolated test') {
      steps {
        script {
          if (!params.TEST_KUBE_CONTEXT?.trim() || !params.TEST_NAMESPACE?.trim() || !params.TEST_BASE_URL?.trim()) {
            error('Set TEST_KUBE_CONTEXT, TEST_NAMESPACE and TEST_BASE_URL for an isolated test deployment.')
          }
          withEnv(["KUBE_CONTEXT=${params.TEST_KUBE_CONTEXT}", "KUBE_NAMESPACE=${params.TEST_NAMESPACE}"]) {
            sh '''sed "s|image: attendance:local|image: $IMAGE_TAG|" k8s/attendance.yaml | kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" apply -f -
              kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" rollout status deployment/attendance --timeout=180s
              kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" get deployment attendance -o yaml > evidence/deployment.yaml
              printf 'context=%s\\nnamespace=%s\\n' "$KUBE_CONTEXT" "$KUBE_NAMESPACE" > evidence/target.txt
            '''
          }
        }
      }
    }
    stage('Selenium') {
      steps {
        script {
          if (!params.TEST_CREDENTIALS_ID?.trim()) { error('Set TEST_CREDENTIALS_ID for the isolated test account.') }
          withCredentials([usernamePassword(credentialsId: params.TEST_CREDENTIALS_ID, usernameVariable: 'TEST_USERNAME', passwordVariable: 'TEST_PASSWORD')]) {
            withEnv(["BASE_URL=${params.TEST_BASE_URL}"]) { sh 'npm run test:selenium > evidence/selenium.txt 2>&1' }
          }
        }
      }
    }
    stage('Traceability') {
      steps {
        sh '''mkdir -p evidence
          { echo "commit=${GIT_COMMIT:-unknown}"
            echo "build=${BUILD_NUMBER:-unknown}"
            echo "image=${IMAGE_TAG:-not-built}"
            echo "context=${TEST_KUBE_CONTEXT:-not-set}"
            echo "namespace=${TEST_NAMESPACE:-not-set}"
            echo "target=${TEST_BASE_URL:-not-set}"
            echo "kindNode=${KIND_NODE:-not-set}"
            echo "node=$(node --version 2>/dev/null || echo unknown)"
          } > evidence/traceability.txt
        '''
      }
    }
  }
  post {
    always {
      archiveArtifacts artifacts: 'evidence/**,test-results/**', allowEmptyArchive: true
    }
    unsuccessful {
      echo 'Pipeline failed: inspect evidence/automated-tests.txt, image build output and any deployment diagnostics before retrying. Remote deployment cleanup must target the exact configured context and namespace.'
    }
  }
}
