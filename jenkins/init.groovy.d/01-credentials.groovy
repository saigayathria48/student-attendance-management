import com.cloudbees.plugins.credentials.CredentialsScope
import com.cloudbees.plugins.credentials.SystemCredentialsProvider
import com.cloudbees.plugins.credentials.domains.Domain
import com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl

def env = System.getenv()
def store = SystemCredentialsProvider.getInstance().getStore()
def existing = store.getCredentials(Domain.global())*.id

def add = { String id, String user, String pass, String description ->
  if (user && pass && !existing.contains(id)) {
    store.addCredentials(Domain.global(), new UsernamePasswordCredentialsImpl(CredentialsScope.GLOBAL, id, description, user, pass))
    println "Added credential ${id}."
  }
}

add('local-registry', env.REGISTRY_USER, env.REGISTRY_PASS, 'Local container registry login')
add('attendance-admin', env.TEST_ADMIN_USER, env.TEST_ADMIN_PASS, 'Dedicated administrator in the isolated test deployment')
store.save()
