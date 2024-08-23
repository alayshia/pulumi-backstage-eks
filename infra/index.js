const pulumi = require("@pulumi/pulumi");
const awsx = require("@pulumi/awsx");
const aws = require("@pulumi/aws");
const k8s = require("@pulumi/kubernetes");
const docker = require("@pulumi/docker");

const config = new pulumi.Config();
const useMinikube = config.getBoolean("useMinikube");
const k8sNamespace = config.get("k8sNamespace") || "backstage";
const kubeconfig = useMinikube ? config.require("kubeconfig") : "";
const username = config.require("dockerUsername");
const password = config.require("dockerPassword");
const dockerImageName = config.require("dockerImageName");
const githubSecret = config.require("githubSecret");
const githubClient = config.require("githubClient");

// Kubernetes provider setup
let k8sProvider;
let serviceAccountName = "backstage-sa";

// Create the Kubernetes Namespace
const namespace = new k8s.core.v1.Namespace("backstage-namespace", {
    metadata: { name: k8sNamespace },
});

// Build and push the Docker image
const dockerImage = new docker.Image("backstage-image", {
    build: {
        context: "../app/backstage/",
        dockerfile: "../app/backstage/packages/backend/Dockerfile",
        // platform: "linux/amd64",
    },
    imageName: pulumi.interpolate`${dockerImageName}:latest`,
    skipPush: false, // Push to the Docker registry
    registry: {
        server: "docker.io",
        username,
        password,
    },
});

if (useMinikube) {
    // Minikube development setup
    k8sProvider = new k8s.Provider("minikube", {
        kubeconfig,
    });

    // Create the ServiceAccount for Minikube
    serviceAccountName = "backstage-sa-minikube";
    new k8s.core.v1.ServiceAccount(serviceAccountName, {
        metadata: {
            namespace: k8sNamespace,
            name: serviceAccountName,
        },
    }, { provider: k8sProvider, dependsOn: namespace });

} else {
    // Production setup on AWS EKS
    const vpc = new awsx.ec2.Vpc("vpc", { numberOfAvailabilityZones: 2 });
    const cluster = new aws.eks.Cluster("backstage-cluster", {
        vpcId: vpc.id,
        subnetIds: vpc.publicSubnetIds,
        instanceType: config.require("eksNodeGroupInstanceType"),
        desiredCapacity: config.requireNumber("eksDesiredCapacity"),
    });

    k8sProvider = cluster.provider;

    new k8s.core.v1.ServiceAccount(serviceAccountName, {
        metadata: {
            namespace: k8sNamespace,
            name: serviceAccountName,
        },
    }, { provider: k8sProvider, dependsOn: namespace });

    pulumi.export("kubeconfig", cluster.kubeconfig);
}

// PostgreSQL Persistent Volume Claim, Deployment, and Service
const postgresPvc = new k8s.core.v1.PersistentVolumeClaim("postgres-pvc", {
    metadata: { namespace: k8sNamespace },
    spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
            requests: { storage: "10Gi" },
        },
    },
}, { provider: k8sProvider, dependsOn: namespace });

const postgresDeployment = new k8s.apps.v1.Deployment("postgres-deployment", {
    metadata: { namespace: k8sNamespace },
    spec: {
        selector: { matchLabels: { app: "postgres" } },
        replicas: 1,
        template: {
            metadata: { labels: { app: "postgres" } },
            spec: {
                containers: [{
                    name: "postgres",
                    image: "postgres:13",
                    ports: [{ containerPort: 5432 }],
                    env: [
                        { name: "POSTGRES_USER", value: "backstage" },
                        { name: "POSTGRES_PASSWORD", value: "backstage" },
                    ],
                    volumeMounts: [{ mountPath: "/var/lib/postgresql/data", name: "postgres-data" }],
                }],
                volumes: [{
                    name: "postgres-data",
                    persistentVolumeClaim: { claimName: postgresPvc.metadata.name },
                }],
            },
        },
    },
}, { provider: k8sProvider, dependsOn: namespace });

const postgresService = new k8s.core.v1.Service("postgres-service", {
    metadata: { namespace: k8sNamespace },
    spec: {
        selector: { app: "postgres" },
        ports: [{ port: 5432, targetPort: 5432 }],
        type: "ClusterIP",
    },
}, { provider: k8sProvider, dependsOn: namespace });

// Backstage Setup: Persistent Volume, Deployment, and Service
const pvc = new k8s.core.v1.PersistentVolumeClaim("backstage-pvc", {
    metadata: { namespace: k8sNamespace },
    spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
            requests: { storage: useMinikube ? "10Gi" : "20Gi" },
        },
        storageClassName: useMinikube ? undefined : "gp2",
    },
}, { provider: k8sProvider, dependsOn: namespace });

const deployment = new k8s.apps.v1.Deployment("backstage-deployment", {
    metadata: { namespace: k8sNamespace },
    spec: {
        selector: { matchLabels: { app: "backstage" } },
        replicas: 1,
        template: {
            metadata: { labels: { app: "backstage" } },
            spec: {
                serviceAccountName,
                containers: [{
                    name: "backstage",
                    image: dockerImage.imageName, // Use the same image for both environments
                    ports: [{ containerPort: 7007 }],
                    volumeMounts: [{ mountPath: "/data", name: "backstage-data" }],
                    env: [
                        { name: "DATABASE_CLIENT", value: "pg" },
                        { name: "POSTGRES_HOST", value: pulumi.interpolate`${postgresService.metadata.name}.${k8sNamespace}.svc.cluster.local` },
                        { name: "POSTGRES_PORT", value: "5432" },
                        { name: "POSTGRES_USER", value: "backstage" },
                        { name: "POSTGRES_PASSWORD", value: "backstage" },
                        { name: "AUTH_GITHUB_CLIENT_ID", value: githubClient},
                        { name: "AUTH_GITHUB_CLIENT_SECRET", value: githubSecret },
                    ],
                }],
                volumes: [{
                    name: "backstage-data",
                    persistentVolumeClaim: { claimName: pvc.metadata.name },
                }],
            },
        },
    },
}, { provider: k8sProvider, dependsOn: [namespace, dockerImage] });

const service = new k8s.core.v1.Service("backstage-service", {
    metadata: { namespace: k8sNamespace },
    spec: {
        selector: deployment.spec.template.metadata.labels,
        ports: [{ port: 80, targetPort: 7007 }],
        type: useMinikube ? "ClusterIP" : "LoadBalancer",
    },
}, { provider: k8sProvider, dependsOn: namespace });

exports.serviceEndpoint = useMinikube
    ? service.spec.clusterIP.apply(ip => `http://127.0.0.1:55206`)
    : service.status.loadBalancer.ingress.apply(
        (ingress) => ingress[0].ip || ingress[0].hostname
    );