# Deploying Backstage on AWS EKS w/ Pulumi Plugin

Installing Backstage + Pulumi Plugin on EKS 

## Troubleshooting

### Development

`kubectl logs -f  pods/backstage-deployment-XXXXXXXXXX -n backstage`

`minikube service backstage-service-XXXXXXXXXX -n backstage --url`

`kubectl exec -it backstage-deployment-XXXXXXXXXX -n backstage -- /bin/sh`